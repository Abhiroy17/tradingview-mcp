# ── Stage 1: Build React UI ──────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder

WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci

COPY ui/ ./
RUN npm run build

# ── Stage 2: Production Server ───────────────────────────────────────────────
FROM node:20-alpine AS runner

# Set timezone to IST so node-cron runs at correct times
ENV TZ=Asia/Kolkata
RUN apk add --no-cache tzdata

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY dashboard.js ./
COPY scripts/kill-port.js ./scripts/

# Copy built React UI from build stage
COPY --from=ui-builder /app/ui/dist ./ui-dist

# Create persistent data directory (mounted as Fly volume in production)
RUN mkdir -p .data

# Dashboard port
EXPOSE 3456

# Health check — Fly.io uses this to determine app readiness
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3456/health || exit 1

# Run in headless mode (no TradingView Desktop in cloud)
ENV HEADLESS=true
ENV PORT=3456

CMD ["node", "dashboard.js"]
