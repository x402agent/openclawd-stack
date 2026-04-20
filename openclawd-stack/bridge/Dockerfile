FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source
COPY . .

# Build
RUN npm run build || true

# Run server
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
