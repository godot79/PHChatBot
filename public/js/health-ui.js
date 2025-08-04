document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('testForm');
  const responseBox = document.getElementById('response');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneNumber = document.getElementById('phoneNumber').value.trim();
    const message = document.getElementById('message').value.trim();

    responseBox.textContent = '📡 Sending...';

    try {
      const res = await fetch('/test-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, message }),
      });

      const data = await res.json();
      if (data.success) {
        responseBox.textContent = `✅ Message sent to ${phoneNumber}`;
      } else {
        responseBox.textContent = `❌ Error: ${data.error || 'Unknown error'}`;
      }
    } catch (err) {
      responseBox.textContent = `🚨 Failed to send message: ${err.message}`;
    }
  });
});
