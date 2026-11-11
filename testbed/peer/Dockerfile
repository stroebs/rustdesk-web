# A headless RustDesk peer (the "remote computer") for end-to-end tests of the
# browser client. It runs RustDesk on a virtual X display showing a test pattern.
FROM debian:bookworm-slim

ARG RUSTDESK_VERSION=1.5.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb x11-apps xterm dbus-x11 procps libayatana-appindicator3-1 x11-xserver-utils xclip \
 && curl -fsSL -o /tmp/rustdesk.deb \
      "https://github.com/rustdesk/rustdesk/releases/download/${RUSTDESK_VERSION}/rustdesk-${RUSTDESK_VERSION}-x86_64.deb" \
 && apt-get install -y --no-install-recommends /tmp/rustdesk.deb \
 && rm -rf /tmp/rustdesk.deb /var/lib/apt/lists/*

# RustDesk derives its device UUID from the machine ID. Without a fixed one, every
# restart looks like a different machine and hbbs refuses the ID (UUID mismatch).
RUN echo 7e57bed0000000000000000000000001 > /etc/machine-id \
 && mkdir -p /var/lib/dbus && cp /etc/machine-id /var/lib/dbus/machine-id

COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
