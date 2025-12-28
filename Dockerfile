# Use a stable Node.js base image
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system-installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Use npm install because package-lock.json was deleted
RUN npm install --omit=dev

# Copy the rest of the code
COPY . .

EXPOSE 8080

CMD [ "node", "server.js" ]
