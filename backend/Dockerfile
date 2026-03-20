FROM node:20

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install

COPY . .

WORKDIR /app/backend

EXPOSE 8080

CMD ["node", "server.js"]