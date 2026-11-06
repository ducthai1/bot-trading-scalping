FROM node:22-alpine

WORKDIR /app

# Copy package config
COPY package.json ./

# Copy source code
COPY . .

# Start bot
CMD ["npm", "start"]

