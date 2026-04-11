# Use lightweight Node.js runtime
FROM node:20-alpine

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Cloud Run expects the app to listen on PORT environment variable
ENV PORT=8080
CMD ["npm", "run", "start"]
