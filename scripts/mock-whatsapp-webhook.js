const express = require('express');
const app = express();
const bodyParser = require('body-parser');
require('dotenv').config();

app.use(bodyParser.json());

app.post('/webhook', (req, res) => {
  console.log('Incoming Mock WhatsApp Message:', req.body);
  res.status(200).json({ status: 'mock received' });
});

const PORT = process.env.MOCK_PORT || 3030;
app.listen(PORT, () => {
  console.log(`Mock WhatsApp webhook running on port ${PORT}`);
});
