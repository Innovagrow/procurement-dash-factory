# ---- builder -------------------------------------------------------------
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

# Prisma schema must be present before install: postinstall runs prisma generate.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx prisma generate && npx tsc -p tsconfig.json

# Drop dev dependencies for the runtime layer.
RUN npm prune --omit=dev

# ---- runtime -------------------------------------------------------------
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl libc6-compat tini curl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# The dashboard is served from src/public; the server resolves it relative to dist.
COPY --from=builder /app/src/public ./src/public

RUN addgroup -g 1001 -S upbid && adduser -u 1001 -S upbid -G upbid && chown -R upbid:upbid /app
USER upbid

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health/live" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/bootstrap/all-in-one.js"]
