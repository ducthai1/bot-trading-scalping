FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cached layer); node_modules is excluded by .dockerignore
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy source code
COPY . .

# Start bot
CMD ["npm", "start"]
