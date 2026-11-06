#!/usr/bin/env bash
# Prepara lo spazio di uno studio su un server condiviso. Idempotente.
# Tocca SOLO: utente di sistema "jarai", cartella /srv/jarai/<studio>.
# Non installa pacchetti, non tocca firewall, proxy o altri servizi.
#
# Uso (da root o con sudo):  prepara-studio.sh <studio> [--applica]
# Senza --applica mostra soltanto cosa farebbe.
set -euo pipefail

STUDIO="${1:-}"
APPLICA="${2:-}"
[[ "$STUDIO" =~ ^[a-z0-9-]+$ ]] || { echo "Uso: $0 <studio-in-minuscolo> [--applica]"; exit 1; }

BASE=/srv/jarai
DIR="$BASE/$STUDIO"

esegui() {
  if [[ "$APPLICA" == "--applica" ]]; then echo "+ $*"; "$@"; else echo "[prova] $*"; fi
}

[[ "$APPLICA" == "--applica" && $EUID -ne 0 ]] && { echo "Serve root (sudo) per --applica"; exit 1; }

# Utente di sistema senza shell: possiede i dati, i container girano con il suo uid.
if ! id jarai >/dev/null 2>&1; then
  esegui useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin jarai
fi

# dati/      jarai.db, sessioni claude, segreti cifrati
# pratiche/  copia delle cartelle delle pratiche
# backup/    staging locale prima dell'invio cifrato fuori dal server
for d in "$BASE" "$DIR" "$DIR/dati" "$DIR/pratiche" "$DIR/backup"; do
  [[ -d "$d" ]] || esegui mkdir -p "$d"
done
esegui chown -R jarai:jarai "$BASE"
# Solo l'utente jarai legge i dati dello studio: gli altri servizi del server no.
esegui chmod 750 "$BASE"
esegui chmod 700 "$DIR" "$DIR/dati" "$DIR/pratiche" "$DIR/backup"

if [[ ! -f "$DIR/.env" ]]; then
  echo "Ricorda: copia deploy/.env.example in $DIR/.env (permessi 600, proprietario jarai)."
fi

if [[ "$APPLICA" == "--applica" ]]; then echo "Fatto."; else echo "Nessuna modifica: rilancia con --applica."; fi
