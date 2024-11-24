const readline = require('readline');
const axios = require('axios');
const fs = require('fs');

// Load the context text
const text = fs.readFileSync('./src/data.txt', 'utf-8');
const url = 'http://127.0.0.1:11434/api/chat';
const headers = {
  'Content-Type': 'application/json',
};

// Prepare the system message
const systemMessage = `
أنت مساعد عربي ماهر ولطيف.
ستتحدث مع العملاء بهدف جمع معلومات منهم بشكل متسلسل.
عند تواصل العميل معك أطلب منه أولا ارسال اسمه في المحادثة. وبعد استقبال اسم العميل قم بشكره شخصيا وأخبره أنك ستطرح عليه خمسة اسئلة ويجب على العميل الاجابة عليها وفق تعليمات كل سؤل.
يجل أن لا تنتقل للسؤل التالي حتى يجب العميل السؤال السابق له.
السؤال الاول: قم بتحديد وجهة نظرك بأحد الخيارات 1-موافق، 2-محايد، 3-غير موافق. هل توفر المؤسسة لكم أجهزة حاسب حديثة؟
السؤال الثاني: قم بتحديد وجهة نظرك بأحد الخيارات 1-دائما، 2-نادرا، 3-إطلاقا. هل تحفز الشركة الموظفين على التدريب على الحاسب؟
السؤال الثالث: قم بتحديد وجهة نظرك بأحد الخيارات 1-موافق، 2-محايد، 3-غير موافق. هل توجد لدى المؤسسة استراتيجية في مجال الحاسب؟
السؤال الرابع: قم بتحديد وجهة نظرك بأحد الخيارات 1-موافق، 2-محايد، 3-غير موافق. هل ترى أن الحاسب مهم جدا في مجال تطوير اعمال المؤسسة؟
السؤال الخامي: قم بتحديد وجهة نظرك بأحد الخيارات 1-موافق، 2-محايد، 3-غير موافق. هل ترغب بالاستمرار في المؤسسة؟
تأكد من اجابة لعميل على جميع الاسئلة وفي الختام قدم للعميل قائمة بالاسئلة واختياره لجواب كل سؤال.
`;

// Initialize chat history
const chatHistory = [
  { role: 'system', content: systemMessage },
];

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("Start chatting with the AI! Type 'exit' to end the chat.");

// Function to send a message to the AI and handle the response
async function sendMessageToAI(userMessage) {
  try {
    // Add user message to the chat history
    chatHistory.push({ role: 'user', content: userMessage });

    // Prepare data to send to the API
    const data = {
      model: 'llama3.2-vision:latest',
      messages: chatHistory,
    };

    // Send request to the API
    const response = await axios.post(url, data, { headers, timeout: 260000 });

    // Parse the response content
    const jsonObjects = response.data.split('\n');
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

    // Add assistant's response to chat history
    chatHistory.push({ role: 'assistant', content: fullContent });

    // Display the response
    console.log('AI:', fullContent);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response error data:', error.response.data);
    }
  }
}

// Function to handle user input
rl.on('line', async (input) => {
  if (input.toLowerCase() === 'exit') {
    console.log('Exiting the chat. Goodbye!');
    rl.close();
    return;
  }

  // Send the user's input to the AI
  await sendMessageToAI(input);
});

