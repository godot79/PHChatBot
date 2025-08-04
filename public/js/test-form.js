// File: public/js/test-form.js

console.log("✅ Loaded test-form.js");

// --- DOM Elements ---
const form = document.getElementById('testMessageForm');
const status = document.getElementById('status');
const chatLog = document.getElementById('chat-log');

// --- Clear chat handler ---
document.getElementById('clear-chat').addEventListener('click', () => {
  chatLog.innerHTML = '';
  status.textContent = '';
});

/**
 * Append a message to the chat log.
 * @param {'you'|'bot'} from - Message sender
 * @param {string} text - Message text (may contain \n linebreaks)
 */
const appendMessage = (from, text) => {
  const msg = document.createElement('div');
  msg.className = from === 'you' ? 'user-message' : 'bot-message';
  // Convert \n to <br> for multi-line support
  msg.innerHTML = text.replace(/\n/g, '<br>');
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
};

// --- Form submit handler ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const phone = document.getElementById('phoneNumber').value;
  const message = document.getElementById('message').value;

  status.textContent = "⏳ Sending...";
  appendMessage('you', message);

  try {
    console.log("📡 Sending POST to /test-message", { phoneNumber: phone, message });

    const res = await fetch('/test-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, message })
    });

    const result = await res.json();
    console.log("✅ Response from /test-message:", result);

    if (result.success) {
      // Extract reply text. Can be string or object.
      const reply =
        typeof result.result === 'string'
          ? result.result
          : result.result?.text ||
            (result.result?.messages ? '✅ Message sent via WhatsApp' : JSON.stringify(result.result));
      appendMessage('bot', reply);
      status.textContent = '✅ Sent';
    } else {
      appendMessage('bot', `⚠️ ${result.error || 'Unknown error'}`);
      status.textContent = '❌ Error';
    }
  } catch (err) {
    appendMessage('bot', `❌ JS Error: ${err.message}`);
    status.textContent = `❌ Exception: ${err.message}`;
  }
});
