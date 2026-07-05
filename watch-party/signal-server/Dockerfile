FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=9000 HOST=0.0.0.0 PATH_PREFIX=/ KEY=peerjs
EXPOSE 9000
CMD ["node", "server.js"]
