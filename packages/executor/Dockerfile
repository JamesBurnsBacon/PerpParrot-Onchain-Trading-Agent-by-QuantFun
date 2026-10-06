# Railway service: set the build context to the repository root (packages/shared is shared).
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY packages/shared ./packages/shared
COPY packages/executor/package.json packages/executor/bun.lock ./packages/executor/
RUN cd packages/executor && bun install --frozen-lockfile --production
COPY packages/executor ./packages/executor
WORKDIR /app/packages/executor
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "src/server.ts"]
