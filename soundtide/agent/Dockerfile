# NOTE: this Dockerfile is built from the repo root so it can reach pwa/.
# docker-compose.yml sets:
#   build:
#     context: .
#     dockerfile: agent/Dockerfile

# 1) Build the PWA bundle.
FROM node:22-bookworm-slim AS pwa-build
WORKDIR /pwa
COPY pwa/package.json pwa/package-lock.json* ./
RUN npm install --include=dev
COPY pwa/tsconfig.json pwa/vite.config.ts pwa/index.html ./
COPY pwa/public ./public
COPY pwa/src ./src
RUN npm run build

# 2) Build the agent (TypeScript + native better-sqlite3 toolchain).
FROM node:22-bookworm-slim AS agent-build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --include=dev
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

# 3) Final small runtime image: agent + built PWA bundle.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=agent-build /app/node_modules ./node_modules
COPY --from=agent-build /app/dist ./dist
COPY --from=agent-build /app/package.json ./package.json
COPY --from=pwa-build /pwa/dist ./pwa-dist

# Multicast / UPnP / HTTP / WS all share host networking via docker-compose.
EXPOSE 7780 7790
CMD ["node", "dist/index.js"]
