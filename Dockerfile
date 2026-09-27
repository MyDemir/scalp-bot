# ── Scalp Sinyal Motoru — Fly.io için Dockerfile ────────────────────────────
#
# better-sqlite3 native modül olduğu için build aşamasında derleme
# araçları (python3, make, g++) gerekiyor. Multi-stage build ile
# bu araçları final image'a taşımıyoruz — image küçük kalıyor.

# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# better-sqlite3 derlemesi için gerekli araçlar
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Runtime'da better-sqlite3'ün ihtiyaç duyduğu paylaşımlı kütüphaneler
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json ./

# SQLite dosyası burada saklanacak — fly.toml'daki [mounts] ile
# kalıcı bir volume'a bağlanıyor, yoksa her deploy'da veri sıfırlanır
RUN mkdir -p /data
ENV DB_PATH=/data/signals.db
ENV NODE_ENV=production

# Bot bir arka plan worker'ı — HTTP servisi açmıyor
CMD ["node", "src/index.js"]
