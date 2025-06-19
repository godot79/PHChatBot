const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';

async function testChatbot() {
  try {
    console.log('🧪 Testing Physiotherapy Chatbot...\n');
    
    // Test 1: Health check
    console.log('1. Testing health check...');
    const healthResponse = await axios.get('http://localhost:3000/health');
    console.log('✅ Health check:', healthResponse.data.status);
    
    // Test 2: Request phone verification
    console.log('\n2. Testing phone verification...');
    const phoneResponse = await axios.post(`${API_BASE}/verify-phone`, {
      phoneNumber: '+1555123001' // Test number that will work in dev mode
    });
    
    console.log('✅ Phone verification response:', phoneResponse.data.message);
    
    // For testing, we'll simulate the SMS code (check server logs for actual code)
    const codeId = phoneResponse.data.codeId;
    const testCode = '123456'; // This won't work - check server logs for real code
    
    console.log(`\n📱 Check server console for SMS code for +1555123001`);
    console.log(`   Then run: npm test -- --code YOUR_ACTUAL_CODE`);
    
    // If code provided as argument, continue testing
    const providedCode = process.argv.find(arg => arg.startsWith('--code='))?.split('=')[1];
    
    if (providedCode) {
      console.log(`\n3. Testing code verification with code: ${providedCode}`);
      const codeResponse = await axios.post(`${API_BASE}/verify-code`, {
        codeId,
        code: providedCode
      });
      
      console.log('✅ Code verification successful');
      
      const sessionToken = codeResponse.data.sessionToken;
      
      // Test 4: Chat messages
      console.log('\n4. Testing chat messages...');
      const testMessages = [
        'Hello',
        'What are your hours?',
        'Show me my appointments',
        'Where is the clinic located?',
        'I have pain in my back',
        'How do I cancel my appointment?'
      ];
      
      for (const message of testMessages) {
        console.log(`\n💬 Sending: "${message}"`);
        const chatResponse = await axios.post(`${API_BASE}/chat`, {
          message,
          sessionToken
        });
        console.log(`🤖 Bot response: "${chatResponse.data.response}"`);
        
        // Add delay between messages
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      console.log('\n✅ All tests completed successfully!');
    } else {
      console.log('\n⏳ Partial test completed. Run with actual verification code to continue.');
    }
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Make sure the server is running: npm run dev');
    }
  }
}

// Check if server is running first
async function checkServer() {
  try {
    await axios.get('http://localhost:3000
