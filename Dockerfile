# Native Chromium + its OS sandbox. Remote mode never adds --no-sandbox.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=ca,target=/usr/local/share/ca-certificates/session.crt \
    if [ -f /usr/local/share/ca-certificates/session.crt ]; then export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/session.crt; fi; \
    npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN --mount=type=secret,id=ca,target=/usr/local/share/ca-certificates/session.crt \
    apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node test/fixtures/compiled ./test/fixtures/compiled
USER node
ENV NODE_ENV=production TWMCP_MODE=remote-chatgpt TWMCP_CHROME_PATH=/usr/bin/chromium PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/http.js"]
