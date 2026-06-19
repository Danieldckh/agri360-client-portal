FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
