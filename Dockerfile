# Use a stable Node.js base image
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system-installed Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of your backend code
COPY . .

# Expose the port your server.js uses (currently 8080)
EXPOSE 8080

CMD [ "node", "server.js" ]
