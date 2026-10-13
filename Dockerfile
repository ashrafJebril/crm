# ─── Build ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Vite inlines env at build time, so these must be build args, not runtime env.
ARG VITE_API_URL
ARG VITE_WA_APP_ID
ARG VITE_EMBED_PARENT_ORIGINS
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WA_APP_ID=$VITE_WA_APP_ID
ENV VITE_EMBED_PARENT_ORIGINS=$VITE_EMBED_PARENT_ORIGINS

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Serve ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV FRAME_ANCESTORS="'self'"
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
