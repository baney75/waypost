# Waypost server image: the committed single-file runtime on a pinned Node.js base. No build step, no npm at runtime.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY runtime/waypost.mjs /app/waypost.mjs
# The data volume inherits this owner and mode on first use; Waypost refuses group- or world-readable state.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV WAYPOST_CONFIG=/data/config.json NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["node", "/app/waypost.mjs", "--config", "/data/config.json"]
CMD ["serve"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
