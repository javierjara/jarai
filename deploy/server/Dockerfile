# JarAI Server: un solo file JavaScript (src/server, impacchettato da
# scripts/costruisci-server.sh) su Node 24, che ha node:sqlite. Accanto,
# l'SDK di Claude con il suo eseguibile per Linux: serve all'assistente di
# riserva (src/server/motore.ts), che lo avvia come processo separato.
# Chromium headless con puppeteer-core: DeJure per l'assistente di riserva
# (src/server/dejure.ts).
FROM node:24-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG SDK_VERSIONE
ARG PUPPETEER_VERSIONE
RUN npm install --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk@${SDK_VERSIONE} puppeteer-core@${PUPPETEER_VERSIONE} \
  && npm cache clean --force
ENV JARAI_CHROMIUM=/usr/bin/chromium
COPY server.mjs /app/server.mjs
ARG VERSIONE=sviluppo
ENV JARAI_VERSIONE=$VERSIONE
# Sessioni di Claude in RAM: /tmp è un tmpfs nel compose (root in sola lettura).
ENV JARAI_SESSIONI=/tmp
# L'utente lo decide il compose (uid di "jarai" sul server); questo è il default.
USER node
EXPOSE 8787
CMD ["node", "/app/server.mjs"]
