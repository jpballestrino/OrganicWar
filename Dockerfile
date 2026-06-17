# Multi-stage Dockerfile for OrganicWar.io
# Stage 1: Build WASM + frontend assets
# Stage 2: Lean production runtime (no Rust toolchain)

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Install Rust toolchain + wasm-pack
RUN apt-get update && apt-get install -y curl build-essential && \
    curl https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable && \
    ~/.cargo/bin/cargo install wasm-pack && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN SKIP_BUILD_CHECK=1 npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built assets and server code from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/src/js ./src/js
COPY --from=builder /app/src/wasm ./src/wasm
COPY --from=builder /app/migrations ./migrations

# Create writable directories for DB and backups
RUN mkdir -p /data/backups /app/logs && \
    ln -s /data/organicwar.db /app/server/organicwar.db || true

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Mount /data as a volume for the SQLite database + backups
VOLUME ["/data"]

CMD ["node", "server/server.js"]
