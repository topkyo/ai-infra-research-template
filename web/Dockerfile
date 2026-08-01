FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall runs scripts/ensure-better-sqlite3.mjs
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DEEPSEEK_API_KEY=dummy-ci-key
RUN npm run build

FROM node:22-slim AS runner
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
CMD ["npm", "run", "start", "--", "-p", "3000"]
