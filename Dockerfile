# Prepared separately from the live devnet service; release gate must pass.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts/build.mjs scripts/build-mainnet.mjs scripts/fingerprint-assets.mjs scripts/playground-page.mjs scripts/mainnet-page.mjs scripts/rules-page.mjs scripts/rules-source.mjs scripts/site-pages.mjs ./scripts/
COPY web-source ./web-source
COPY programs ./programs
COPY config/mainnet.prepared.json ./config/
COPY artifacts/solana_pot_game.so ./artifacts/solana_pot_game.so
RUN node scripts/build-mainnet.mjs && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-mainnet ./dist-mainnet
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config/mainnet.prepared.json ./config/mainnet.prepared.json
COPY --chown=node:node scripts/start-mainnet.mjs scripts/serve-mainnet.mjs ./scripts/
USER node
EXPOSE 8080
CMD ["node", "scripts/start-mainnet.mjs"]
