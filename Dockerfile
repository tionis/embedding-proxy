FROM oven/bun:1-alpine

# Install Litestream (multi-arch: amd64 / arm64)
ARG LITESTREAM_VERSION=0.3.13
ARG TARGETARCH=amd64
RUN apk add --no-cache ca-certificates curl && \
    curl -fL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin && \
    apk del curl

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

COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
