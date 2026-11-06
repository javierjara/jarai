# JarAI Server: installazione su un server condiviso

Primo caso: **Studio Legale Molfino** sul server Hetzner di Botcom. La
procedura è uguale per ogni studio: cambia solo il nome (`molfino`).

> Stato: il server si può **preparare** già adesso. L'immagine `jarai-server`
> arriva con il passo "JarAI Server" di `docs/eventstore-protocollo.md`, e
> solo allora il software si collega.

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
5. **Compose**: si copiano `docker-compose.yml` e `.env` in
   `/srv/jarai/molfino` → `docker compose -p jarai-molfino up -d`
   (quando l'immagine esiste).

## Da fare prima di mettere dentro dati veri

- [ ] **Nomina art. 28** di Botcom da parte dello studio, e **DPA con Hetzner** a nome di Botcom.
- [ ] **Nomina ad amministratore di sistema** (provv. Garante 27/11/2008) per chi ha accesso root.
- [ ] **Log degli accessi** amministrativi conservati per almeno 6 mesi e non modificabili (journald persistente + invio esterno).
- [ ] **Backup cifrati** fuori dal server (restic verso Hetzner Storage Box, in UE), con una prova di ripristino.
- [ ] **Cifratura a riposo** con una chiave che resta allo studio (requisito di JarAI Server).
- [ ] **Datacenter Hetzner in UE** (Falkenstein, Norimberga o Helsinki) verificato.
