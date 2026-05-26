# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps separately so they cache across rebuilds
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .

# Vite inlines VITE_* env vars at build time. They have to be ARG-ed in
# explicitly so docker compose `build.args` can pass them through.
# All four are PUBLIC values — tenant + client IDs are not secrets in the
# PKCE flow.
ARG VITE_API_BASE=/api
ARG VITE_AZURE_TENANT_ID=
ARG VITE_AZURE_CLIENT_ID=
ARG VITE_AZURE_REDIRECT_URI=
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID \
    VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
    VITE_AZURE_REDIRECT_URI=$VITE_AZURE_REDIRECT_URI
RUN npm run build


# ---- Runtime stage: tiny nginx serving the built assets ----
FROM nginx:1.27-alpine AS runtime

# Drop the default config and use ours
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
