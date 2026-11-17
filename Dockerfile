# OrganicWar.io production image.
#   Stage 1 builds the WASM simulation (Rust → both wasm targets) and the
#   client bundle; stage 2 is a lean Node runtime with no Rust toolchain.
#
#   docker build -t organicwar .
#   docker run -p 3000:3000 -v organicwar-data:/data -e JWT_SECRET=... organicwar
#
# The SQLite database and its hourly backups live on the /data volume
# (DB_PATH=/data/organicwar.db) — mount persistent storage there or every
# redeploy starts with an empty database.

# ── Stage 1: build ────────────────────────────────────────────────────────────
# The full Debian image already has curl, python3 and a C toolchain (Rust's
# build scripts and better-sqlite3 need one), so no apt-get step is needed.
FROM node:22-bookworm AS builder

# Rust (minimal profile) + the wasm target, straight from the official
# rustup-init binary; wasm-pack and wasm-opt as prebuilt npm binaries
# (compiling wasm-pack with cargo takes ~10 minutes).
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable --target wasm32-unknown-unknown \
    && rm /tmp/rustup-init
RUN npm install -g wasm-pack@0.15.1 binaryen@132.0.0

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
# Production dependencies from the builder (same Debian release, so the
# compiled better-sqlite3 binding matches) — no compiler or network needed here.
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
# Server code (incl. migrations and the node-target WASM built in stage 1),
# the client bundle, and the shared modules the server imports from src/js.
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/js ./src/js

RUN mkdir -p /data /app/logs && chown -R node:node /data /app/logs
# Runs as root only long enough to take ownership of the data volume, then
# drops to the unprivileged `node` user (see docker-entrypoint.sh).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/organicwar.db

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
