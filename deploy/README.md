# JarAI Server: installazione su un server condiviso

Primo caso: **Studio Legale Molfino** sul server Hetzner di Botcom. La
procedura è uguale per ogni studio: cambia solo il nome (`molfino`).

> Stato (7 novembre 2026): **attivo per Molfino** su
> `https://molfino.jarai.botcom.it`, immagine `jarai-server:0.2.2-6b074e0`.
> Oggi contiene l'archivio cifrato delle pratiche (Server privato); l'host
> con l'assistente arriverà nella stessa immagine.

## Principi (server condiviso)

- **Non si tocca nient'altro**: un utente di sistema `jarai`, la cartella
  `/srv/jarai/<studio>`, un progetto compose `jarai-<studio>`.
- **Nessuna porta pubblicata**: il container sta sulla rete docker `web` e
  si entra solo dal Caddy condiviso (`caddy-caddy-1`, config in
  `/opt/botcom/caddy/sites/*.caddy`), che lo raggiunge per nome.
- **Dati di uno studio leggibili solo da `jarai`**: permessi `700`, container
  senza privilegi e con filesystem in sola lettura tranne i volumi.

## Struttura sul server

```
/srv/jarai/molfino/
├── .env                 600, configurazione e licenza
├── docker-compose.yml
├── dati/                jarai.db, sessioni claude, segreti cifrati
├── pratiche/            copia delle cartelle delle pratiche
└── backup/              staging prima dell'invio cifrato fuori dal server
```

## Procedura

1. **Fotografia del server** (sola lettura):
   `ssh <host> 'bash -s' < scripts/verifica-server.sh`
   Serve a sapere quale reverse proxy c'è, se Docker c'è, quali porte sono occupate.
2. **Spazio dello studio**: si copia `scripts/prepara-studio.sh` sul server,
   si lancia prima senza `--applica` per vedere cosa farà, poi con `--applica`.
3. **DNS** (Vercel DNS di botcom.it, team javitek): `molfino.jarai` → `2.29.157.169`.
   Fatto il 2026-11-06 (A + AAAA). Attenzione: `jarai.botcom.it` ora ha un CNAME
   esplicito verso Vercel; senza, qualsiasi record `x.jarai` lo spegnerebbe.
4. **Caddy**: `proxy/studio.caddy` → `/opt/botcom/caddy/sites/jarai-molfino.caddy`,
   poi `caddy validate` e `caddy reload` dentro `caddy-caddy-1`. Va fatto solo
   quando il container esiste, altrimenti Caddy risponde 502.
   (`proxy/nginx.conf` resta per server con nginx.)
5. **Immagine**: `deploy/scripts/costruisci-server.sh` impacchetta `src/server`
   e costruisce `jarai-server:<versione>` direttamente sul server (niente registry).
6. **Compose**: `docker-compose.yml` e `.env` (600, proprietario jarai; la
   licenza dello studio si prende dal CRM) in `/srv/jarai/molfino`, poi
   `sudo docker compose --project-directory /srv/jarai/molfino -p jarai-molfino up -d`.
   Per aggiornare: nuova immagine, `JARAI_IMAGE` nel `.env`, stesso comando.
7. **CRM**: Licenze → «Server privato» attivo, indirizzo e GB. La pagina
   Server mostra spazio, file, disco e ultimo contatto (il server riferisce
   ogni 5 minuti).

## Da fare prima di mettere dentro dati veri

- [ ] **Nomina art. 28** di Botcom da parte dello studio, e **DPA con Hetzner** a nome di Botcom.
- [ ] **Nomina ad amministratore di sistema** (provv. Garante 27/11/2008) per chi ha accesso root.
- [ ] **Log degli accessi** amministrativi conservati per almeno 6 mesi e non modificabili (journald persistente + invio esterno).
- [ ] **Backup cifrati** fuori dal server (restic verso Hetzner Storage Box, in UE), con una prova di ripristino.
- [x] **Cifratura a riposo** con una chiave che resta allo studio: i file arrivano già cifrati dal
      desktop (`src/core/cifraturaArchivio.ts`), il server rifiuta quelli in chiaro. Vale per
      l'archivio; l'host con l'assistente dovrà ricevere la chiave dallo studio all'avvio.
- [x] **Datacenter Hetzner in UE**: Helsinki (`hel1-dc2`), verificato il 7 novembre 2026.
