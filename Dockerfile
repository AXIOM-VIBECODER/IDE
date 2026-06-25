FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl python3 make g++ procps \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r axiom && useradd -r -g axiom -m -s /bin/bash axiom

WORKDIR /app

# Install deps first (layer cache)
COPY axiom_v6/package.json axiom_v6/package-lock.json* ./axiom_v6/
# node-pty requires native compile (python3 + make + g++ above)
RUN cd axiom_v6 && npm install --omit=dev

# Copy app
COPY axiom_v6/src      ./axiom_v6/src
COPY axiom_v6/public   ./axiom_v6/public
COPY axiom_v6/migrations ./axiom_v6/migrations
COPY axiom_v6/scripts  ./axiom_v6/scripts

RUN mkdir -p /home/axiom/.axiom && chown -R axiom:axiom /home/axiom/.axiom /app
USER axiom

ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:5000/api/ping',r=>{process.exit(r.statusCode<500?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "axiom_v6/src/server.js"]
