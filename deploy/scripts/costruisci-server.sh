#!/usr/bin/env bash
# Costruisce l'immagine jarai-server direttamente sul server (niente registry):
# impacchetta src/server in un file, lo manda via ssh e lancia docker build.
# Uso: deploy/scripts/costruisci-server.sh [host]   (default botcom@2.29.157.169)
set -euo pipefail
HOST="${1:-botcom@2.29.157.169}"
RADICE="$(cd "$(dirname "$0")/../.." && pwd)"
VERSIONE="$(node -p "require('$RADICE/package.json').version")-$(git -C "$RADICE" rev-parse --short HEAD)"
LAVORO="$(mktemp -d)"
trap 'rm -rf "$LAVORO"' EXIT

"$RADICE/node_modules/.bin/esbuild" "$RADICE/src/server/index.ts" --bundle --platform=node --target=node24 \
  --format=esm --outfile="$LAVORO/server.mjs" --log-level=warning
cp "$RADICE/deploy/server/Dockerfile" "$LAVORO/"

echo "Immagine jarai-server:$VERSIONE su $HOST"
COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$LAVORO" -cz . | ssh "$HOST" "set -e; d=\$(mktemp -d); tar -C \$d -xz; \
  docker build -q --build-arg VERSIONE=$VERSIONE -t jarai-server:$VERSIONE -t jarai-server:latest \$d; rm -rf \$d"
echo "$VERSIONE"
