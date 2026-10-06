# Railway service: set the build context to the repository root (packages/shared is shared).
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY packages/shared ./packages/shared
COPY packages/backend/package.json packages/backend/bun.lock ./packages/backend/
RUN cd packages/backend && bun install --frozen-lockfile --production
COPY packages/backend ./packages/backend
WORKDIR /app/packages/backend
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "src/server.ts"]
