#!/usr/bin/env bash
# Sola lettura: fotografa il server prima di installare JarAI Server.
# Non modifica niente. Uso: ssh <host> 'bash -s' < verifica-server.sh
set -u

sezione() { printf '\n== %s\n' "$1"; }

sezione "Sistema"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
uname -r
echo "CPU: $(nproc)  RAM: $(free -h | awk '/Mem:/ {print $2" totali, "$7" disponibili"}')"
df -h / | tail -1 | awk '{print "Disco /: "$2" totali, "$4" liberi ("$5" usato)"}'

sezione "Docker"
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version 2>/dev/null || echo "docker compose: NON presente"
  echo "Container attivi:"
  docker ps --format '  {{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || echo "  (serve sudo per elencarli)"
else
  echo "Docker NON installato"
fi

sezione "Chi ascolta su 80/443 (reverse proxy esistente)"
if command -v ss >/dev/null 2>&1; then
  ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print "  "$4"  "$6}'
fi
for p in nginx caddy traefik apache2 httpd haproxy; do
  if pgrep -x "$p" >/dev/null 2>&1; then echo "  processo attivo: $p"; fi
done
docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -Ei 'nginx|caddy|traefik|haproxy' | sed 's/^/  container: /'

sezione "Porte in ascolto su tutte le interfacce"
ss -ltnH 2>/dev/null | awk '$4 !~ /^(127\.|\[::1\])/ {print "  "$4}' | sort -u

sezione "Firewall"
if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null || echo "  ufw presente (serve sudo per lo stato)"; fi
command -v nft >/dev/null 2>&1 && echo "  nftables presente"

sezione "Accesso SSH"
grep -Ei '^\s*(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^/  /'

sezione "JarAI già presente?"
ls -ld /srv/jarai 2>/dev/null || echo "  /srv/jarai non esiste"
id jarai 2>/dev/null || echo "  utente jarai non esiste"

sezione "Aggiornamenti automatici"
dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii' && echo "  unattended-upgrades installato" || echo "  unattended-upgrades NON installato"
