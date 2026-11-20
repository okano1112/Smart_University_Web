FROM node:22-bookworm-slim

RUN npm install --prefix /usr/src/node-red --omit=dev --no-audit --no-fund node-red@5.0.10 \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data /usr/src/node-red
COPY --chown=node:node node-red/*.js /opt/bimclub/node-red/
COPY --chown=node:node node_red_dht22_environment_flow.json /opt/bimclub/node-red/imports/

USER node
WORKDIR /usr/src/node-red
ENV NODE_RED_USER_DIR=/data \
    NODE_PATH=/usr/src/node-red/node_modules:/data/node_modules

HEALTHCHECK --interval=20s --timeout=3s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.NODE_RED_PORT || 1880) + '/cira-observability', {signal: AbortSignal.timeout(2000)}).then(async response => { if (!response.ok || (await response.json()).source !== 'cira') process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "/opt/bimclub/node-red/docker-entrypoint.js"]
CMD []
