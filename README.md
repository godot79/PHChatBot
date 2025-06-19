# Physiotherapy Chatbot with Cliniko Integration

A secure chatbot for physiotherapy clinics that integrates with Cliniko practice management software. Patients verify their identity using their phone number and can then interact with the bot to get appointment information, clinic details, and general assistance.

## Features

- 📱 **Phone Number Verification**: Secure SMS-based verification using Cliniko patient database
- 🔒 **Session Management**: JWT-based authentication with secure sessions
- 💬 **Smart Chatbot**: Contextual responses for appointments, clinic info, and general queries
- 🏥 **Cliniko Integration**: Real-time access to patient appointments and information
- 🛡️ **Security First**: Rate limiting, input validation, and CORS protection
- 📱 **Mobile Friendly**: Responsive design works on all devices

## Quick Start

### 1. Installation
```bash
# Clone or create project directory
mkdir physio-chatbot && cd physio-chatbot

# Install dependencies
npm install
```

### 2. Configuration
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your Cliniko credentials
nano .env
```

### 3. Setup Database
```bash
# Initialize SQLite database
npm run setup-db
```

### 4. Start Development Server
```bash
# Start with auto-reload
npm run dev

# Or start production server
npm start
```

### 5. Test the Application
- Open http://localhost:3000 in your browser
- Or run automated tests: `npm test`

## Getting Your Cliniko API Key

1. Log into your Cliniko account
2. Navigate to **Settings** → **API Keys**
3. Click **Create API Key**
4. Set permissions:
   - ✅ Read access to Patients
   - ✅ Read access to Appointments
5. Copy the generated API key to your `.env` file

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CLINIKO_API_KEY` | Your Cliniko API key | Yes |
| `CLINIKO_SUBDOMAIN` | Your clinic's Cliniko subdomain | Yes |
| `JWT_SECRET` | Secret key for JWT tokens | Yes |
| `PORT` | Server port (default: 3000) | No |
| `NODE_ENV` | Environment (development/production) | No |

## API Endpoints

- `POST /api/verify-phone` - Request phone verification
- `POST /api/verify-code` - Verify SMS code
- `POST /api/chat` - Send chat message
- `GET /health` - Health check

## Testing

### Automated Testing
```bash
npm test
```

### Manual Testing
1. Use phone numbers that exist in your Cliniko database
2. In development mode, SMS codes are logged to console
3. Test various chat messages like:
   - "What are your hours?"
   - "Show my appointments"
   - "Where are you located?"

## Deployment

### Heroku
```bash
heroku create your-app-name
heroku config:set CLINIKO_API_KEY=your_key
heroku config:set CLINIKO_SUBDOMAIN=your_subdomain
heroku config:set JWT_SECRET=your_secret
git push heroku main
```

### Docker
```bash
docker build -t physio-chatbot .
docker run -p 3000:3000 --env-file .env physio-chatbot
```

## Security Considerations

- 🔐 All API keys stored in environment variables
- 🚦 Rate limiting prevents abuse
- 🛡️ CORS configured for production domains
- 🔑 JWT tokens expire after 24 hours
- 📱 SMS verification prevents unauthorized access

## Troubleshooting

### Common Issues

**"Cliniko API error"**
- Verify your API key is correct
- Check that your Cliniko subdomain is right
- Ensure API key has proper permissions

**"Phone number not found"**
- Make sure the phone number exists in Cliniko
- Check phone number format (try with/without country code)

**"Cannot connect to server"**
- Verify server is running: `npm run dev`
- Check port configuration in `.env`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For support with this chatbot implementation, please check the troubleshooting section or create an issue in the repository.

For Cliniko API support, visit: https://developers.cliniko.com/
```
