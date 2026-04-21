FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Data directory for persistent SQLite volume
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
