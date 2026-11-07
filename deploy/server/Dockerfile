# JarAI Server: un solo file JavaScript (src/server, impacchettato da
# scripts/costruisci-server.sh) su Node 24, che ha node:sqlite. Accanto,
# l'SDK di Claude con il suo eseguibile per Linux: serve all'assistente di
# riserva (src/server/motore.ts), che lo avvia come processo separato.
FROM node:24-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
ARG SDK_VERSIONE
RUN npm install --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk@${SDK_VERSIONE} \
  && npm cache clean --force
COPY server.mjs /app/server.mjs
ARG VERSIONE=sviluppo
ENV JARAI_VERSIONE=$VERSIONE
# Sessioni di Claude in RAM: /tmp è un tmpfs nel compose (root in sola lettura).
ENV JARAI_SESSIONI=/tmp
# L'utente lo decide il compose (uid di "jarai" sul server); questo è il default.
USER node
EXPOSE 8787
CMD ["node", "/app/server.mjs"]
