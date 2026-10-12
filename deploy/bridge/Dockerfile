# Proton Mail Bridge from Proton's official Debian package, checked against a pinned SHA-256.
# Proton publishes no official container; this builds one from the official release instead of a third-party image.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ARG BRIDGE_VERSION=3.27.0-1
ARG BRIDGE_SHA256=4ae1f9a38392379a08ab6cfb61b44078a339f55d1d366bbba0a0d9acf901e900
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl pass gnupg \
 && curl -fsSLo /tmp/bridge.deb "https://proton.me/download/bridge/protonmail-bridge_${BRIDGE_VERSION}_amd64.deb" \
 && echo "${BRIDGE_SHA256}  /tmp/bridge.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/bridge.deb \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /tmp/bridge.deb /var/lib/apt/lists/* \
 && useradd -u 1000 -m -d /home/bridge bridge \
 && mkdir /bridge-public && chown bridge /bridge-public
COPY entrypoint.sh /usr/local/bin/waypost-bridge
RUN chmod 755 /usr/local/bin/waypost-bridge
USER bridge
ENV HOME=/home/bridge
ENTRYPOINT ["/usr/local/bin/waypost-bridge"]
CMD ["run"]
