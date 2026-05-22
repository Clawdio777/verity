#!/bin/sh
set -e

mkdir -p /data

# Seed keyring from env vars if files don't already exist
if [ -n "$KEYRING_JSON_B64" ] && [ ! -f /data/keyring.json ]; then
  echo "$KEYRING_JSON_B64" | base64 -d > /data/keyring.json
  chmod 600 /data/keyring.json
fi

if [ -n "$KEYRING_KEY_B64" ] && [ ! -f /data/keyring.key ]; then
  echo "$KEYRING_KEY_B64" | base64 -d > /data/keyring.key
  chmod 600 /data/keyring.key
fi

exec node seller-v2.mjs
