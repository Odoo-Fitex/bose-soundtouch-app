# Build a small image that runs on Pi 3/4/5 (linux/arm/v7 or arm64).
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 needs a toolchain on first build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Multicast / UPnP / HTTP / WS all share host networking via docker-compose.
EXPOSE 7780 7790
CMD ["node", "dist/index.js"]
