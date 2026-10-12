#!/bin/sh
# Back up the Waypost data volume (config, agent calendar, OAuth state) to a dated tarball beside this script.
# Restore: docker compose down && docker run --rm -v waypost_waypost-data:/data -v "$PWD":/b alpine:3.22 sh -c 'cd /data && tar xzf /b/<file>' && docker compose up -d
set -eu
cd "$(dirname "$0")"
umask 077
file="waypost-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker compose exec -T waypost node /app/waypost.mjs --config /data/config.json store backup --out "/data/store-$(date -u +%s).json" >/dev/null
docker run --rm -v waypost_waypost-data:/data:ro -v "$PWD":/b alpine:3.22 tar czf "/b/$file" -C /data .
echo "$PWD/$file"
