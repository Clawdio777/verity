#!/bin/sh
set -e

mkdir -p /data/share/keyring /data/config/keyring /data/config/acp

# Seed keyring secrets — XDG_DATA_HOME/keyring/secrets.json
if [ -n "$KEYRING_JSON_B64" ] && [ ! -f /data/share/keyring/secrets.json ]; then
  printf '%s' "$KEYRING_JSON_B64" | base64 -d > /data/share/keyring/secrets.json
  chmod 600 /data/share/keyring/secrets.json
fi

# Seed keyring key — XDG_CONFIG_HOME/keyring/file.key
if [ -n "$KEYRING_KEY_B64" ] && [ ! -f /data/config/keyring/file.key ]; then
  printf '%s' "$KEYRING_KEY_B64" | base64 -d > /data/config/keyring/file.key
  chmod 600 /data/config/keyring/file.key
fi

# Seed ACP config (active agent / wallet selection)
if [ -n "$ACP_CONFIG_B64" ] && [ ! -f /data/config/acp/config.json ]; then
  printf '%s' "$ACP_CONFIG_B64" | base64 -d > /data/config/acp/config.json
  chmod 600 /data/config/acp/config.json
fi

exec node seller-v2.mjs
