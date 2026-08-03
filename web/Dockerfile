FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall runs scripts/ensure-better-sqlite3.mjs
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

FROM node:24-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DEEPSEEK_API_KEY=dummy-ci-key
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
# prestart runs ensure-better-sqlite3 + fix-next-server-chunks
COPY --from=builder /app/scripts ./scripts
EXPOSE 3000
# node:24-slim has no curl/wget; Node 24 ships global fetch. docker-compose.yml
# overrides this with the same check — keep both in sync.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "--", "-p", "3000"]
