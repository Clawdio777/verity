FROM node:20-slim

# Install acp-cli globally
RUN npm install -g @virtuals-protocol/acp-cli

# Ensure Linux signer binary is executable
RUN chmod +x /usr/local/lib/node_modules/@virtuals-protocol/acp-cli/bin/acp-cli-signer-linux

WORKDIR /app
COPY seller-v2.mjs .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# /data is a Railway persistent volume — all ACP auth lives here
ENV DATA_DIR=/data
ENV LOG_DIR=/data/logs
ENV XDG_CONFIG_HOME=/data/config
ENV XDG_DATA_HOME=/data/share
ENV ACP_CONFIG_DIR=/data/config/acp

# Use file-based keyring — no D-Bus or gnome-keyring needed in headless containers.
# Tokens stored as AES-256-GCM encrypted JSON on the persistent volume.
ENV TS_KEYRING_BACKEND=file
ENV KEYRING_PROPERTY_FILE_PATH=/data/keyring.json
ENV KEYRING_PROPERTY_KEY_FILE_PATH=/data/keyring.key

CMD ["/app/entrypoint.sh"]
