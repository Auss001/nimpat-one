# syntax=docker/dockerfile:1.7
# Multi-stage build producing a small, non-root image for Google Cloud Run.

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

FROM deps AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts && npx prisma generate

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node media ./media
RUN mkdir -p uploads && chown node:node uploads
COPY --chown=node:node package.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
