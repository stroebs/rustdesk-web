FROM node:24-alpine

LABEL org.opencontainers.image.title="rustdesk-web" \
      org.opencontainers.image.description="Admin web interface and API server for RustDesk OSS" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=21114

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 21114

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
