FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js index.html ./

EXPOSE 8080

ENV NODE_ENV=production
CMD ["node", "server.js"]
