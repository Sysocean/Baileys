import axios from 'axios';
import fs from 'fs';

(async () => {
  try {
    const text = fs.readFileSync('./src/data.txt', 'utf-8');
    const url = 'http://127.0.0.1:11434/api/chat';
    const headers = {
      'Content-Type': 'application/json',
    };

    const systemMessage = `
    You are a helpful Arabic assistant. Please follow these instructions:
    1. If the user's query contains a greeting, greet the user warmly and thank them for reaching out.
    2. Always respond in a brief and concise manner, ensuring clarity and sufficient detail to address the query effectively.
    3. Provide clear, informative answers to the user's questions based on the provided context.
    4. You are one of our team members, so you can always use (we and us) to foster a sense of collaboration and accessibility.
    5. If the knowledge does not contain the answer, apologize, and let the user know that we will escalate the query to customer support, providing them with the expected response time.
    6. Before searching for an answer, evaluate the quality of the question and your understanding of it. If the question is unclear, kindly ask the customer for clarification before attempting to provide a response.
    7. Use the following context or knowledge in your answer: <guide>${text}</guide>
    `;

    const chatHistory = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: "السلام عليكم، هل أنت ذكاء اصطناعي؟" },
      { role: 'assistant', content: "أنا هنا لخدمتك، تفضل!" },
    ];

    const data = {
      model: 'llama3.2-vision:latest', //'llama3.2-vision:latest'
      messages: chatHistory,
    };

    // Log the data being sent to verify its structure
    console.log('Sending data:', JSON.stringify(data, null, 2));

    const response = await axios.post(url, data, { headers, timeout: 260000 });

    console.log('Response status:', response.status);
    //console.log('Response data:', response.data);

    const jsonObjects = response.data.split('\n');
    let fullContent = jsonObjects
        .map(item => {
            item = item.trim();
            if (!item) return ''; 
//
            try {
                const parsed = JSON.parse(item);
                return parsed.message ? parsed.message.content : ''; 
            } catch (error) {
                console.error('Error parsing JSON item:', error, item); 
                return ''; 
            }
        })
        .join('');
//
    console.log('Parsed content:', fullContent); 

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response error data:', error.response.data);
    }
  }
})();
