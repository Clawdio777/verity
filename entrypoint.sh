#!/bin/sh
set -e

mkdir -p /data/share/keyring /data/config/keyring /data/config/acp

# Seed ACP config (active agent / wallet selection)
if [ -n "$ACP_CONFIG_B64" ] && [ ! -f /data/config/acp/config.json ]; then
  printf '%s' "$ACP_CONFIG_B64" | tr -d '[:space:]' | base64 -d > /data/config/acp/config.json
  chmod 600 /data/config/acp/config.json
  echo "[entrypoint] config.json seeded"
fi

# Check if keyring is ready (set up via Railway terminal)
if [ ! -f /data/share/keyring/secrets.json ] || [ ! -f /data/config/keyring/file.key ]; then
  echo "[entrypoint] =============================================="
  echo "[entrypoint] SETUP REQUIRED — no keyring found."
  echo "[entrypoint] Open Railway terminal and run:"
  echo "[entrypoint]   acp configure"
  echo "[entrypoint]   acp agent use --id 019e4e4d-e09b-7a2d-b20d-6acfbbc12a93"
  echo "[entrypoint]   acp agent add-signer"
  echo "[entrypoint] Then approve the signer URL in the browser."
  echo "[entrypoint] Container will keep retrying every 30s..."
  echo "[entrypoint] =============================================="
  while [ ! -f /data/share/keyring/secrets.json ] || [ ! -f /data/config/keyring/file.key ]; do
    sleep 30
    echo "[entrypoint] Waiting for keyring setup..."
  done
  echo "[entrypoint] Keyring found — starting seller."
fi

exec node seller-v2.mjs
