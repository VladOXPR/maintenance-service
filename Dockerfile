# Use the official Node.js runtime as the base image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (lockfile-driven, reproducible)
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8080

# Cloud Run sets PORT; default matches local/Dockerfile expectations
ENV NODE_ENV=production
ENV PORT=8080

# Start the application
CMD ["node", "server.js"]
