FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN python -m venv /opt/voice \
    && /opt/voice/bin/pip install --no-cache-dir faster-whisper==1.2.1
RUN groupadd --gid 1000 bimclub \
    && useradd --uid 1000 --gid 1000 --create-home bimclub \
    && mkdir -p /app/data \
    && chown -R bimclub:bimclub /app/data
COPY --chown=1000:1000 . .

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VOICE_PYTHON=/opt/voice/bin/python \
    NODE_RED_PORT=1880
USER bimclub
RUN /opt/voice/bin/python docker/prepare-models.py \
    && /opt/voice/bin/python -c "import sys; sys.path.insert(0, 'offline-voice'); from asr_worker import Recognizer; Recognizer(); print('Whisper CPU ready')"
EXPOSE 3000 1881
HEALTHCHECK --interval=20s --timeout=4s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/login', {signal: AbortSignal.timeout(3000)}).then(response => {if (![200,503].includes(response.status)) process.exit(1);}).catch(() => process.exit(1))"
ENTRYPOINT ["node", "docker/web-entrypoint.js"]
