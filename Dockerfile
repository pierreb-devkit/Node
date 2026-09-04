# Pinned to the major declared in .nvmrc (not `lts-slim`, which floats
# independently of it). Kept in sync by scripts/tests/dockerfileToolchain.unit.tests.js.
FROM node:24-slim

# switch user
USER node

# Create app directory
WORKDIR /home/node

# Install app dependencies & setup
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
COPY --chown=node:node package*.json .npmrc ./
RUN if [ "$NODE_ENV" = "test" ]; then npm ci --include=dev; else npm ci --omit=dev; fi
COPY --chown=node:node . .

# Expose
EXPOSE 3000 4200

# Command to run
CMD [ "node", "server.js" ]