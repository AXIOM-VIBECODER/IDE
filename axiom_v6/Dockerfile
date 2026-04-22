# ╔══════════════════════════════════════════════════════════════╗
# ║  AXIOM v6 — Production Dockerfile                           ║
# ╚══════════════════════════════════════════════════════════════╝

# ── Stage 1: Build native dependencies ───────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

# ── Stage 2: Production image ────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    python3 \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r axiom && useradd -r -g axiom -m -s /bin/bash axiom

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules

COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

RUN mkdir -p /home/axiom/.axiom && chown -R axiom:axiom /home/axiom/.axiom
RUN chown -R axiom:axiom /app

USER axiom

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:5000/api/ping || exit 1

CMD ["node", "src/server.js"]
