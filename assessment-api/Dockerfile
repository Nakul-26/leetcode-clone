FROM node:20-alpine

WORKDIR /usr/src/app

# Copy contracts directory so schema validation works in production
COPY contracts /usr/src/contracts
COPY contracts ./contracts

# Switch to non-root user workspace
RUN chown -R node:node /usr/src/app /usr/src/contracts
USER node

# --chown is required here: COPY ignores the active USER and copies as root
# by default, which made `npm install` (running as node) fail with EACCES on
# package-lock.json on a build with no prior cached layers to mask it.
# devDependencies are kept in (no --omit=dev) because docker-compose.yml's dev
# service runs `npm run dev` (`node --watch`, no extra package) and the tests need vitest.
COPY --chown=node:node assessment-api/package*.json ./
RUN npm ci

# Copy application source
COPY --chown=node:node assessment-api/ .

EXPOSE 5000

CMD ["node", "src/server.js"]
