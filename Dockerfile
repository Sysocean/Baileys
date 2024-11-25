# Use the official Node.js image
FROM node:22 AS builder

ENV NODE_ENV=production

# Set the working directory
WORKDIR /worker

# In case npm is outdated it might need to be updated
# RUN npm install -g npm@10.9.1

RUN node --version && npm --version
RUN yarn -v
RUN ls -al

# Copy the source code to the container
COPY src ./src
COPY WAProto ./WAProto
COPY WASignalGroup ./WASignalGroup
COPY tsconfig.json ./
COPY package.json ./
# Install dependencies
RUN yarn install

RUN yarn remove sharp --dev
RUN yarn remove qrcode-terminal --dev
RUN yarn remove link-preview-js --dev
RUN yarn remove jimp --dev
RUN yarn remove open --dev

RUN yarn add sharp@0.32.6
RUN yarn add qrcode-terminal@0.12.0
RUN yarn add link-preview-js@3.0.0
RUN yarn add jimp@0.16.1
RUN yarn add open@8.4.2
# 
RUN yarn add @types/node --dev

# Build the TypeScript files
RUN npm run dockerbuild:tsc

# Expose the application port
EXPOSE 3000


# Production stage
# FROM node:22
# WORKDIR /worker
# COPY --from=builder /worker ./worker
# Run the application
CMD ["node", "lib/server.js"]