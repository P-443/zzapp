FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libx11-xcb1 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 3000
CMD ["npm", "start"]
