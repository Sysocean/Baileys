import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidUser, makeCacheableSignalKeyStore, makeInMemoryStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from './'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs, { existsSync, unlinkSync, rmSync } from 'fs'
import { writeFile, readFile } from 'fs/promises';

import P from 'pino'
import axios from 'axios';
import path, { resolve } from 'path';

const ACCOUNT_MANAGER = '966503889883'

const userMessageQueue = {};
const userTimeouts = {};
const DELAY_TIME = 10000; // 10 seconds

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const useStore = true // !process.argv.includes('--no-store')
const doReplies = true // process.argv.includes('--do-reply')
const usePairingCode = false //process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./alhar6i_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./alhar6i_store_multi.json')
}, 10_000)

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('./alhar6i_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`Using Alhar6i WA v${version.join('.')}, isLatest: ${isLatest} @ ${new Date().toJSON()}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)


	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						delay(7000)
						startSock()
					} else {
						deleteStoreAndAuth()
						console.log('You are logged out.\nYou can run the app next time if you which to use the AI service!')
					}
				}
				
				// WARNING: THIS WILL SEND A WAM EXAMPLE AND THIS IS A ****CAPTURED MESSAGE.****
				// DO NOT ACTUALLY ENABLE THIS UNLESS YOU MODIFIED THE FILE.JSON!!!!!
				// THE ANALYTICS IN THE FILE ARE OLD. DO NOT USE THEM.
				// YOUR APP SHOULD HAVE GLOBALS AND ANALYTICS ACCURATE TO TIME, DATE AND THE SESSION
				// THIS FILE.JSON APPROACH IS JUST AN APPROACH I USED, BE FREE TO DO THIS IN ANOTHER WAY.
				// THE FIRST EVENT CONTAINS THE CONSTANT GLOBALS, EXCEPT THE seqenceNumber(in the event) and commitTime
				// THIS INCLUDES STUFF LIKE ocVersion WHICH IS CRUCIAL FOR THE PREVENTION OF THE WARNING
				const sendWAMExample = false;
				if(connection === 'open' && sendWAMExample) {
					/// sending WAM EXAMPLE
					const {
						header: {
							wamVersion,
							eventSequenceNumber,
						},
						events,
					} = JSON.parse(await fs.promises.readFile("boot_analytics_test.json", "utf-8"))

					const binaryInfo = new BinaryInfo({
						protocolVersion: wamVersion,
						sequence: eventSequenceNumber,
						events: events
					})

					const buffer = encodeWAM(binaryInfo);
					
					const result = await sock.sendWAMBuffer(buffer)
					//console.log(result)
				}

				//console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events['labels.association']) {
				//console.log(events['labels.association'])
			}


			if(events['labels.edit']) {
				//console.log(events['labels.edit'])
			}

			if(events.call) {
				//console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					//console.log('received on-demand history sync, messages=', messages)
				}
				//console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				//console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if(upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						//TODO: More built-in implementation of this
						/* if (
							msg.message?.protocolMessage?.type ===
							proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION
						  ) {
							const historySyncNotification = getHistoryMsg(msg.message)
							if (
							  historySyncNotification?.syncType ==
							  proto.HistorySync.HistorySyncType.ON_DEMAND
							) {
							  const { messages } =
								await downloadAndProcessHistorySyncNotification(
								  historySyncNotification,
								  {}
								)

								
								const chatId = onDemandMap.get(
									historySyncNotification!.peerDataRequestSessionId!
								)
								
								console.log(messages)

							  onDemandMap.delete(
								historySyncNotification!.peerDataRequestSessionId!
							  )

							  /*
								// 50 messages is the limit imposed by whatsapp
								//TODO: Add ratelimit of 7200 seconds
								//TODO: Max retries 10
								const messageId = await sock.fetchMessageHistory(
									50,
									oldestMessageKey,
									oldestMessageTimestamp
								)
								onDemandMap.set(messageId, chatId)
							}
						  } */
						let customerMessage:String = ''
						if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
							const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
							customerMessage = text || ""
							if (text == "requestPlaceholder" && !upsert.requestId) {
								const messageId = await sock.requestPlaceholderResend(msg.key) 
								//console.log('requested placeholder resync, id=', messageId)
							} else if (upsert.requestId) {
								//console.log('Message received from phone, id=', upsert.requestId, msg)
							}

							// go to an old chat and send this
							if (text == "onDemandHistSync") {
								const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!) 
								//console.log('requested on-demand sync, id=', messageId)
							}
						}

						if(!msg.key.fromMe && doReplies && isJidUser(msg.key?.remoteJid!)) {

							const senderMobile = msg.key.remoteJid!.split('@')[0]

							// Normalize senderMobile by removing leading '+' and '00'
							const normalizedMobile = senderMobile.replace(/^(\+|00)/, '');

							// Check if the first 3 characters after normalization are not "966"
							if (!normalizedMobile.startsWith("966")) {
								return; // Or perform your desired action
							}
							
							if (senderMobile == ACCOUNT_MANAGER)
							{
								adminTask(customerMessage, true)
								return
							}

							if(getIgnoreMessagesStatus())
							{
								return
							}

							    // Initialize the message queue for the user if not already present
							if (!userMessageQueue[msg.key?.remoteJid!]) {
								userMessageQueue[msg.key?.remoteJid!] = [];
							}

							// Add the new message to the user's queue
							userMessageQueue[msg.key?.remoteJid!].push(customerMessage);

							// Clear any existing timeout for this user
							if (userTimeouts[msg.key?.remoteJid!]) {
								clearTimeout(userTimeouts[msg.key?.remoteJid!]);
							}

							// Set a new timeout to process the messages after the delay
							userTimeouts[msg.key?.remoteJid!] = setTimeout(async () => {
								// Collect all messages for this user
								const userQuestion = userMessageQueue[msg.key?.remoteJid!].join('\n');
								
								// Clear the user's message queue
								delete userMessageQueue[msg.key?.remoteJid!];
								delete userTimeouts[msg.key?.remoteJid!];
								

								// The POST and send here
								(async () => {
									

									//console.log('replying to', msg.key.remoteJid)
									await sock!.readMessages([msg.key])
	
									try {

									  
									  // Resolve the path dynamically based on the current file's directory
									  const filePath = resolve(__dirname, 'data.txt');

									  const text = fs.readFileSync(filePath, 'utf-8');
									  const url = 'http://127.0.0.1:11434/api/generate' //'http://127.0.0.1:11434/api/chat';
									  const headers = {
										'Content-Type': 'application/json',
									  };
								  
//									  const systemMessage = `
									//You are a helpful Arabic assistant. Please follow these instructions:
									//1. If the user's query contains a greeting, start your response by greeting the user and thank them for reaching out.
									//2. Ensure the question is clear, complete, and well-understood before searching for an answer. If the question lacks clarity or completeness, politely tell the user that you didn't get the point of the message and ask the user for clarification before proceeding.
									//3. If the knowledge does not contain the answer, apologize, and let the user know that you will escalate the query to customer support.
									//4. In your answers, always, respond in a brief and concise manner, ensuring clarity and sufficient detail based on the provided context to address the query effectively.
									//5. You are one of our team members, so always use (we and us) to foster a sense of collaboration and accessibility.
									//6. Use the following knowledge in your answer: <guide>${text}</guide>.
//									  `;

									//const systemMessage = `
									//You are a helpful and professional Arabic assistant. Please follow these instructions strictly:
//
									//1. If the user's query contains a greeting then start your response by greeting the user and thank them for reaching out.
									//2. Ensure the query is clear and complete before providing an answer. If the question is unclear, politely ask for clarification in Arabic.
									//3. Use only the information provided in <guide>${text}</guide> to answer the user's question. Do not include any information outside this guide, even if it seems relevant.
									//4. Answer directly after the greeting without repeating or rephrasing the user's question.
									//5. Avoid explaining your process or mentioning that you have read the question. Provide the answer succinctly and professionally.
									//6. If the required answer is not available in the guide, apologize politely in Arabic and inform the user that their query will be escalated to customer support.
									//7. Always write your responses entirely in Arabic, regardless of the language of the user's query.
									//8. Maintain a professional yet friendly tone in your responses. Avoid using casual or strange expressions.
									//9. Provide concise yet comprehensive answers that directly address the user's question.
									//10. Ensure all details, such as prices or features, are accurately taken from the guide. Do not infer or invent any information.
									//`

									const systemMessage =`You are a professional Arabic assistant. Start with a greeting if the user greets you, and ensure the query is clear before answering. Use only the information provided in <guide>${text}</guide> without adding external details. Respond concisely without rephrasing or explaining your process. If the answer isn't in the guide, apologize in Arabic and escalate the query. Always respond in Arabic with a professional and friendly tone, providing accurate details directly from the guide without inferring or inventing information. If the question is unrelated to the product or involves religious, sectarian, political, unethical, or sexual topics, politely inform the user that the query is outside the scope of our services and provide a brief, respectful response. Do not engage in discussions on sensitive, inappropriate, or sexual topics.`

									// 
									
									
									//const systemMessage = `
									//You are a helpful Arabic assistant. Please follow these instructions:
//
									//1. Always greet the user and thank them for reaching out. 
									//2. Ensure the query is clear and complete before searching for an answer. If the question is unclear, politely ask for clarification.
									//3. Use the information in <guide>${text}</guide> to provide precise and context-relevant answers. Avoid using information outside this context.
									//4. If the answer is not available in the provided knowledge, apologize and inform the user that their query will be escalated to customer support.
									//5. Keep your responses concise but detailed enough to address the user's question effectively.
									//6. Always use "we" and "us" to maintain a collaborative and accessible tone.
									//7. All responses must be written in Arabic, regardless of the language of the user's query."
									//`;
							  
									// Example response: 
									// - User asks: "What are your services?"
									// - Response: "Thank you for reaching out! Our company specializes in providing [specific services from <guide>${text}</guide>]. Let us know if you need further details.
									const prompt = `
									${systemMessage}
									User's question: ${userQuestion}
									`;

									// Prepare the data payload
									const data = {
									model: 'llama3.2-vision:latest', // Replace with your model
									prompt: prompt,
									};

									/*
									//Using chat

									 const chatHistory = [
										{ role: 'system', content: systemMessage },
										{ role: 'user', content: userQuestion },
										{ role: 'assistant', content: "أنا هنا لخدمتك، تفضل!" },
									 ];
								  

									  const data = {
										model: 'llama3.2-vision:latest', //'llama3.2-vision:latest'
										messages: chatHistory,
									  };
									*/

									  const response = await axios.post(url, data, { headers, timeout: 260000 });
								  
									  //console.log('Response status:', response.status);
									  //console.log('Response data:', response.data);
								  
									  const jsonObjects = response.data.split('\n');


									  /*
									  //This work for chat
									 let fullContent = jsonObjects
									 	  .map(item => {
									 		  item = item.trim();
									 		  if (!item) return ''; 
									 		  try {
									 			  const parsed = JSON.parse(item);
									 			  return parsed.message ? parsed.message.content : ''; 
									 		  } catch (error) {
									 			  console.error('Error parsing JSON item:', error, item); 
									 			  return ''; 
									 		  }
									 	  })
									 	  .join('');
										*/

										//this work for 
										let fullContent = jsonObjects
										  .map(item => {
											  item = item.trim();
											  if (!item) return ''; 
											  try {
												  const parsed = JSON.parse(item);
												  return parsed.response ? parsed.response : ''; 
											  } catch (error) {
												  console.error('Error parsing JSON item:', error, item); 
												  return ''; 
											  }
										  })
										  .join('');

									  //console.log('Parsed content:', fullContent); 
									  await sendMessageWTyping({ text: fullContent }, msg.key.remoteJid!)

									  appendToCSV(userQuestion, fullContent)

									  const senderMobile = msg.key.remoteJid!.split('@')[0]
									  const whatsappJID = msg.key.remoteJid!.split('@')[1]
									  await sendMessageWTyping({ text: 'السؤال: ' + userQuestion + '\nالجواب: ' + fullContent + '\n' +   senderMobile }, '966503889883@' + whatsappJID)

									} catch (error) {
									  console.error('Error:', error.message);
									  if (error.response) {
										console.error('Response error data:', error.response.data);
									  }
									}
								  })();		
			
							}, DELAY_TIME);

							
						}
						else
						{
							if(msg.message!.protocolMessage)
								return
							
							adminTask(customerMessage, false)

							return

						}
						//End
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				//console.log(
				//	JSON.stringify(events['messages.update'], undefined, 2)
				//)

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if(pollCreation) {
							//console.log(
							//	'got poll update, aggregation: ',
							//	getAggregateVotesInPollMessage({
							//		message: pollCreation,
							//		pollUpdates: update.pollUpdates,
							//	})
							//)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				//console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				//console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				//console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				//console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						//console.log(
						//	`contact ${contact.id} has a new profile pic: ${newUrl}`,
						//)
					}
				}
			}

			if(events['chats.delete']) {
				//console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if(store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

function deleteStoreAndAuth() {
	const filePath = './alhar6i_store_multi.json';
	const folderPath = './alhar6i_auth_info';
  
	// Check if the file exists and delete it
	if (existsSync(filePath)) {
	  try {
		unlinkSync(filePath);
		console.log(`Store "${filePath}" deleted successfully.`);
	  } catch (error) {
		console.error(`Error deleting store "${filePath}":`, error);
	  }
	} else {
	  console.log(`Store "${filePath}" does not exist.`);
	}
  
	// Check if the folder exists and delete it
	if (existsSync(folderPath)) {
	  try {
		rmSync(folderPath, { recursive: true, force: true });
		console.log(`Auth "${folderPath}" deleted successfully.`);
	  } catch (error) {
		console.error(`Error deleting Auth "${folderPath}":`, error);
	  }
	} else {
	  console.log(`Auth "${folderPath}" does not exist.`);
	}
  }

startSock()


function getIgnoreMessagesStatus(): boolean {
    const fileName = '.ignoreincomemessages';
    const filePath = path.join(process.cwd(), fileName);

    // Check if the file exists
    if (fs.existsSync(filePath)) {
        return true;
    }

	return false

}

function setIgnoreStatus(input: string) {
    const fileName = '.ignoreincomemessages';
	const currentDirectory = __dirname;

    const filePath = path.join(currentDirectory, fileName);

	if(input.toLowerCase() == 'stop')
	{
		if(!fs.existsSync(filePath))
		{
			// Create a new empty file 
			fs.writeFileSync(filePath, '');
		}
	}
	else if(input.toLowerCase() == 'boot')
	{
		if(fs.existsSync(filePath))
		{
			fs.unlinkSync(filePath);
		}
	}

}

function appendToCSV(firstParam: string, secondParam: string): void {
    // Get the current directory (where the script is running from)
    const currentDirectory = __dirname;

    // Construct the file path relative to the current directory
    const filePath = path.join(currentDirectory, 'data.csv');

    // Prepare the data to append
    const dataToAppend = `${firstParam || ''},${secondParam || ''}\n`;

    // Append the data to the CSV file
    fs.appendFile(filePath, dataToAppend, (err) => {
        if (err) {
            console.error('Error appending data to CSV file:', err);
        } else {
            console.log('Data successfully appended to CSV file.');
        }
    });
}


async function adminTask(input: String, superadmin: Boolean): Promise<void> {
	// Resolve the path dynamically based on the current file's directory
	const dataFilePath = resolve(__dirname, 'data.txt');

    // Check if the input starts with 'DATA:' and has content after the colon
    if (input.startsWith('DATA:') && superadmin) {
        const newText = input.slice(5); // Extract the text after 'DATA:'

        try {
            // Write the new text to the file
            await writeFile(dataFilePath, newText, 'utf-8');
            console.log('File updated successfully');
        } catch (error) {
            console.error('Error writing to the file:', error);
        }
    } else if (input.startsWith('STOP')) {
		setIgnoreStatus('STOP')
		console.log('Stop the service');
	} else if (input.startsWith('BOOT')) {
		setIgnoreStatus('BOOT')
		console.log('Restart the service');
	}
	else {

	}
}