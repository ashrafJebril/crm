# ─── Build ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Prisma's query engine links against OpenSSL at runtime; node:*-slim ships without it.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# node_modules is copied whole (not pruned) so the Prisma CLI stays available for
# the `prisma migrate deploy` release command, which runs from this same image.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

# Fallback media root used when DO_SPACES_* is unset (see media/storage/storage.provider.ts).
RUN mkdir -p /app/uploads

EXPOSE 8080
CMD ["node", "dist/main"]
