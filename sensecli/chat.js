import fetch from 'node-fetch';

const API_BASE = 'https://apihub.agnes-ai.cn/v1';
const TOKEN = 'sk-gN07qfrBHlXFKcd63PZOr8Dy5eMHDy2TkTrdkgfreTd31B5E';
const MODEL = 'agnes-2.0-flash';

const history = [];

async function chat(message, maxTokens = 200) {
  history.push({ role: 'user', content: message });
  
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      max_tokens: maxTokens
    })
  });
  
  const data = await response.json();
  if (data.error) {
    console.error('API Error:', data.error);
    return null;
  }
  
  const reply = data.choices[0].message.content;
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// 交互式模式
if (process.argv.length > 2) {
  const userMessage = process.argv.slice(2).join(' ');
  const reply = await chat(userMessage);
  console.log(reply || 'No response');
} else {
  console.log('SenseNova Chat CLI');
  console.log('Usage: node chat.js "your message"');
  console.log('Or run without args for interactive mode');
}
