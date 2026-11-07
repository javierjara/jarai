# JarAI Server: un solo file JavaScript (src/server, impacchettato da
# scripts/costruisci-server.sh) su Node 24, che ha node:sqlite.
FROM node:24-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY server.mjs /app/server.mjs
ARG VERSIONE=sviluppo
ENV JARAI_VERSIONE=$VERSIONE
# L'utente lo decide il compose (uid di "jarai" sul server); questo è il default.
USER node
EXPOSE 8787
CMD ["node", "/app/server.mjs"]
