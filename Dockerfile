FROM node:lts-slim

# switch user
USER node

# Create app directory
WORKDIR /home/node

# Install app dependencies & setup
ARG NODE_ENV=production
COPY --chown=node:node package*.json ./
RUN if [ "$NODE_ENV" = "test" ]; then npm install; else npm install --production; fi
COPY --chown=node:node . .

# Expose
EXPOSE 3000 4200

# Command to run
CMD [ "node", "server.js" ]