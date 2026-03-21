FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies (only devDeps needed — Bun runs TS directly)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy application source
COPY *.ts *.html ./

# Data directory — mount a volume here in production
RUN mkdir -p /data
VOLUME ["/data"]

ENV PORT=8080 \
    DB_PATH=/data/data.db

EXPOSE 8080

CMD ["bun", "run", "/app/index.ts"]
