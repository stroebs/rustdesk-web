# The data directory is prepared on the build platform so the final stage has no
# RUN steps; that lets `docker buildx` produce arm64/amd64 images without emulation.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS prep
RUN mkdir -p /out/data

FROM node:24-alpine

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="rustdesk-web" \
      org.opencontainers.image.description="Admin web interface and API server for RustDesk OSS" \
      org.opencontainers.image.source="https://github.com/stroebs/rustdesk-web" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# The server starts as root only to take ownership of the data directory (so bind
# mounts that Docker created as root:root work), then drops to PUID:PGID before
# opening the database. Set PUID/PGID to match the owner of a host directory.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=21114 \
    PUID=1000 \
    PGID=1000

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY --from=prep --chown=node:node /out/data /data

VOLUME ["/data"]
EXPOSE 21114

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
