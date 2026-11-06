# EventStore e protocollo host ↔ client

Piano tecnico del **primo passo** verso "Continua sul telefono" (spec §9) e
"JarAI Server" per gli studi con un server proprio. Qui **non** si fanno
relay, PWA o server. Si prepara la base che rende quei tre passi semplici:

1. il processo main diventa l'**host**: possiede lo stato e lo scrive in modo durevole;
2. lo stato delle conversazioni è un **log di eventi append-only** con numero di sequenza;
3. un **protocollo unico** (comandi in ingresso, eventi in uscita), uguale
   per il renderer Electron di oggi e per telefono/server di domani.

---

## 1. Cosa c'è oggi (e perché non basta)

| Punto | Dove | Problema per il remoto |
|---|---|---|
| Lo stato lo possiede il **renderer** | `App.tsx` (`useState` + `dati:salva` con debounce 500 ms) | Il telefono non ha un "altrove" da cui leggere: la verità vive in una finestra React |
| Il main manda eventi solo **"in diretta"** | `agentRunner.ts:305` → `claude:evento` | Gli eventi non vengono conservati. Un client collegato a metà turno non può recuperare ciò che si è perso |
| La conversazione viene **assemblata nella vista** | `ConversazioneView.tsx:54-135` | Se l'avvocato cambia vista durante lo streaming, i delta vanno persi e la conversazione non viene salvata (vale anche oggi, senza telefono) |
| Salvataggio a **file intero** | `store.ts` (`jarai-dati.json`) | Ogni modifica riscrive tutto il file: non c'è modo di dire "cosa è cambiato dopo X" |
| `resume` dell'SDK **in memoria** | `agentRunner.ts:144` `sessioniPerConversazione` | Dopo un riavvio la conversazione riparte senza contesto (va contro il criterio §12.6 della spec) |
| Nessuna conferma bloccante | niente `canUseTool` | Le approvazioni dal telefono (§9.2) richiedono uno stato "in attesa di conferma" persistito |

Nota: i punti 3 e 5 sono bug reali anche senza telefono. Questo lavoro li
corregge.

---

## 2. Architettura target

```
                ┌──────────────────────── HOST (main Electron, poi JarAI Server) ────────────────────────┐
 comandi  ───▶  │ CommandBus ──▶ AgentRunner / servizi pratiche ──▶ EventStore (SQLite, append-only)    │
                │                                                     │                                  │
 eventi   ◀───  │ Hub abbonamenti ◀───────────── proiezioni (reducer condiviso) ◀──┘                     │
                └────────────────────────────────────────────────────────────────────────────────────────┘
                      ▲ Trasporto IPC (oggi)       ▲ Trasporto relay (Fase 6)      ▲ Trasporto WS/HTTP (Server)
                  Renderer Electron              Telefono PWA                     Desktop come client
```

- **Un solo scrittore**: l'host. I client inviano comandi e non scrivono mai
  lo stato direttamente. Così non servono CRDT né risoluzione dei conflitti.
- **Reducer condiviso** in `src/shared/`: una funzione pura `(stato, evento) → stato`
  usata dall'host per le proiezioni e dai client per aggiornare la UI. È
  TypeScript senza dipendenze da Electron, quindi gira identica nella PWA e
  sul server.

---

## 3. Persistenza: SQLite

**Scelta:** `node:sqlite` (integrato in Node, nessun modulo nativo).
- Electron 33 (attuale) usa Node 20, dove `node:sqlite` non c'è. Serve
  **Electron ≥ 37** (Node 22.16+). L'aggiornamento è utile comunque: Electron
  33 è fuori supporto.
- Perché non `better-sqlite3`: è un modulo nativo da ricompilare per ogni
  versione di Electron, e l'installer Windows viene costruito dal Mac
  (`scripts/prepara-binari-win.mjs`). Sarebbe un terzo binario da gestire a
  mano, mentre `node:sqlite` funziona uguale anche sul futuro JarAI Server
  (Node 22 in Docker).
- Ripiego se l'aggiornamento di Electron si blocca: `better-sqlite3` con
  `@electron/rebuild` e il binario win32 aggiunto a `prepara-binari-win.mjs`.

File: `userData/jarai.db`, in WAL mode. Cifratura a riposo (§10.2): fuori da
questo passo, ma si tiene in conto (SQLCipher non è disponibile con
`node:sqlite`; in alternativa si cifrano i `payload` con una chiave in
`safeStorage`, da decidere).

### 3.1 Schema (sottoinsieme di spec §8.2, più i campi per il remoto)

```sql
CREATE TABLE host (id TEXT PRIMARY KEY, nome TEXT, creato_il TEXT);       -- 1 riga: identità del computer/server
CREATE TABLE utente (id TEXT PRIMARY KEY, nome TEXT, ruolo TEXT);         -- per ora 1 riga; serve al Server multi-utente
CREATE TABLE dispositivo (id TEXT PRIMARY KEY, utente_id TEXT, nome TEXT, tipo TEXT,
                          chiave_pubblica TEXT, collegato_il TEXT, revocato_il TEXT);

CREATE TABLE pratica (id TEXT PRIMARY KEY, nome TEXT, cliente TEXT, controparte TEXT, ambito TEXT,
                      note TEXT, cartella_percorso TEXT, aggiornata_il TEXT, eliminata_il TEXT);
CREATE TABLE documento (id TEXT PRIMARY KEY, pratica_id TEXT, nome TEXT, tipo TEXT, pagine INTEGER,
                        data TEXT, cartella TEXT, dimensione INTEGER, percorso TEXT);

CREATE TABLE conversazione (id TEXT PRIMARY KEY, modalita TEXT,           -- 'pratica' | 'studio-digitale'
                            pratica_id TEXT, titolo TEXT, procedura TEXT, qualita TEXT,
                            sdk_session_id TEXT,                          -- resume persistente
                            creata_da_dispositivo TEXT, creata_il TEXT, eliminata_il TEXT);

-- Il cuore: un unico log append-only per tutto l'host.
CREATE TABLE evento (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,   -- cursore globale e monotono
  conversazione_id TEXT,                              -- NULL per eventi non di conversazione (pratiche, impostazioni)
  tipo           TEXT NOT NULL,
  payload        TEXT NOT NULL,                       -- JSON, validato con zod
  utente_id      TEXT, dispositivo_id TEXT,           -- chi l'ha causato (registro Attività, §7)
  comando_id     TEXT,                                -- idempotenza: stesso comando inviato due volte = un evento solo
  creato_il      TEXT NOT NULL
);
CREATE INDEX evento_conv ON evento(conversazione_id, seq);
CREATE UNIQUE INDEX evento_comando ON evento(comando_id, tipo) WHERE comando_id IS NOT NULL;

-- Proiezione materializzata per elenchi veloci (sidebar, schermata "In attesa" del telefono).
CREATE TABLE conversazione_stato (conversazione_id TEXT PRIMARY KEY, stato TEXT, attivita TEXT,
                                  piano TEXT, ultimo_seq INTEGER, aggiornata_il TEXT);
```

Le altre entità dello Studio digitale (idee, preferenze, copertine, stato di
pubblicazione) sono tabelle normali, aggiornate dall'host. Ogni modifica emette
anche un evento `entita_cambiata` nel log, così i client sanno cosa
ricaricare.

**Differenza rispetto alla spec:** la spec indica `seq` *per conversazione*.
Qui si propone un **`seq` globale**: il client tiene un solo cursore ("dammi
tutto dopo 1234") e riceve sia i messaggi sia i cambi dell'elenco pratiche.
L'ordine dentro una conversazione si ottiene filtrando.

---

## 4. Eventi

Tutti hanno `{ seq, tipo, conversazioneId?, creatoIl, dispositivoId?, payload }`,
con schema zod in `src/shared/protocollo/eventi.ts`.

| Tipo | Persistito | Payload | Note |
|---|---|---|---|
| `conversazione_creata` | sì | modalita, praticaId, titolo, procedura, qualita | |
| `messaggio_utente` | sì | messaggioId, testo | Contiene il dispositivo d'origine ("dal telefono") |
| `turno_iniziato` | sì | turnoId, modello | |
| `attivita` | sì, solo l'ultima conta | testo | Frase italiana, mai il nome dello strumento |
| `testo_delta` | **no**, solo in diretta | turnoId, testo | Troppi per il log: vedi 4.1 |
| `testo_assistente` | sì | turnoId, messaggioId, testo, fonti? | Testo finale completo del turno |
| `lavori` | no, solo in diretta | lavori[] | Avanzamento lettura documenti |
| `piano` | sì | passi[] | |
| `bozza_versione` | sì | bozzaId, numero, titolo, contenuto | Oggi: evento `bozza` |
| `articolo` / `idee` | sì | come oggi | Studio digitale |
| `conferma_richiesta` | sì | confermaId, livello, titolo, anteprima | Prepara §7; nel passo 1 solo tipo e reducer |
| `conferma_risposta` | sì | confermaId, esito, nota | |
| `turno_finito` | sì | turnoId, esito (`ok`/`errore`/`interrotto`), costoUsd?, messaggioErrore?, testoParziale? | Sostituisce `completato`/`errore`. `testoParziale` serve perché i delta non sono nel log; `messaggioErrore` è solo il motivo, il reducer compone "parziale + ⚠ motivo" |
| `conversazione_eliminata` | sì | | Cancellazione logica, rimozione fisica dopo |
| `entita_cambiata` | sì | entita, id, azione | pratica, documento, idea, preferenze… |

### 4.1 Streaming e riconnessione

- I `testo_delta` passano solo tramite l'hub e non vengono scritti nel log.
  Il log riceve un unico `testo_assistente` a fine turno.
- L'host tiene in memoria il **testo parziale del turno in corso**. Lo
  snapshot di una conversazione attiva lo include
  (`turnoInCorso: { turnoId, testoParziale, attivita }`). Un telefono che si
  collega a metà risposta vede subito il testo già scritto e poi i delta
  successivi.
- Crash a metà turno: all'avvio, ogni `turno_iniziato` senza `turno_finito`
  viene chiuso con `turno_finito { esito: 'interrotto' }`.

---

## 5. Comandi

In `src/shared/protocollo/comandi.ts`, ciascuno con `comandoId` (uuid generato
dal client) per l'idempotenza: in caso di riconnessione il client li reinvia
senza duplicarli.

| Comando | Effetto |
|---|---|
| `conversazione.crea` | `conversazione_creata` |
| `conversazione.invia` { testo, qualita } | `messaggio_utente` + avvio turno |
| `conversazione.ferma` | abort → `turno_finito { interrotto }` |
| `conversazione.rispondiConferma` { confermaId, esito, nota } | `conferma_risposta` e sblocco del turno |
| `conversazione.elimina` / `rinomina` | |
| `pratica.crea` / `aggiorna` / `elimina`, `documenti.importa` | Oggi vengono fatti nel renderer + `dati:salva`: si spostano nell'host |
| `studio.*` | Studio digitale, stessa logica |

Risposta a ogni comando: `{ ok: true, seq }` oppure `{ ok: false, errore }`
(messaggio in italiano, mai tecnico).

### 5.1 Lettura

| Richiesta | Risposta |
|---|---|
| `snapshot.elenco` | pratiche, conversazioni con stato, `seq` attuale |
| `snapshot.conversazione` { id } | messaggi (ottenuti con il reducer), piano, conferme aperte, turno in corso |
| `eventi.dopo` { seq, limite } | eventi persistiti successivi al cursore (riconnessione) |
| `abbona` { conversazioni?: id[] \| 'tutte' } | flusso in diretta, delta compresi |

Flusso di un client: `snapshot.elenco` → `abbona` → per ogni evento aggiorna
il cursore. Alla riconnessione usa `eventi.dopo(cursore)`. Se il buco è
troppo grande (es. > 5000 eventi) riparte dallo snapshot.

### 5.2 Busta e versione

```ts
type Busta =
  | { v: 1; tipo: 'comando'; id: string; comando: Comando }
  | { v: 1; tipo: 'richiesta'; id: string; richiesta: Richiesta }
  | { v: 1; tipo: 'risposta'; id: string; esito: Esito }
  | { v: 1; tipo: 'evento'; evento: Evento };
```

È la stessa busta per IPC, relay e WebSocket del server. Sul relay viaggia
cifrata (Fase 6), e lì `v` permette a desktop e telefono con versioni
diverse di parlarsi.

---

## 6. Pensato per JarAI Server fin da subito

Fatto ora, costa poco. Rifatto dopo, costa molto:

- **`src/core/` senza import da `electron`**. Le uniche dipendenze
  dall'ambiente passano per tre interfacce:
  ```ts
  interface Percorsi  { dati(): string; temporanei(): string }
  interface Segreti   { leggi(k: string): Promise<string|null>; scrivi(k: string, v: string): Promise<void> }
  interface Trasporto { avvia(host: Host): void }   // IPC oggi; WS/relay domani
  ```
  In Electron l'implementazione usa `app.getPath` e `safeStorage`. Sul
  server usa variabili d'ambiente, una cartella dati e un file di segreti
  cifrato.
- `utente_id` e `dispositivo_id` su ogni evento, anche se oggi c'è un solo
  utente e un solo dispositivo.
- Nessuna logica di dominio nel renderer: il renderer manda comandi e
  disegna le proiezioni.

Questo passo **non** sposta tutti i moduli in `src/core/`. Vale solo per il
codice nuovo (EventStore, protocollo, host). Il resto si sposta quando si fa
il Server.

---

## 7. Migrazione da `jarai-dati.json`

Al primo avvio con la nuova versione:
1. se `jarai.db` non esiste e `jarai-dati.json` sì, si legge con lo schema
   zod attuale (`store.ts`);
2. pratiche e documenti vanno nelle tabelle;
3. ogni conversazione viene trasformata in eventi sintetici:
   `conversazione_creata`, poi per ogni messaggio `messaggio_utente` oppure
   `testo_assistente` (+ `bozza_versione` / `articolo` se presenti),
   `piano`, `turno_finito` coerente con lo `stato`;
4. si rinomina il file in `jarai-dati.migrato-<data>.json` (non si cancella:
   è la via di ritorno);
5. tutto dentro una transazione: se fallisce, si resta sul JSON e il
   problema si registra con `registraErroreGrezzo`.

I dati d'esempio (`datiIniziali.ts`) vengono creati dall'host al primo avvio
"vero", non più dal renderer.

---

## 8. Cosa cambia, file per file

| File | Modifica |
|---|---|
| `package.json` | Electron ≥ 37 |
| **nuovo** `src/shared/protocollo/{eventi,comandi,busta}.ts` | Schemi zod e tipi |
| **nuovo** `src/shared/reducer.ts` | `riduciConversazione`, `riduciElenco`: puri, testati |
| **nuovo** `src/core/eventStore.ts` | `appendi(eventi, {comandoId})` in transazione, `dopo(seq)`, `perConversazione(id)` |
| **nuovo** `src/core/db.ts` + `migrazioni/` | Apertura DB, WAL, migrazioni numerate |
| **nuovo** `src/core/host.ts` | CommandBus, hub degli abbonamenti, stato dei turni in corso |
| **nuovo** `src/core/migrazioneJson.ts` | §7 |
| `src/main/agentRunner.ts` | `invia()` scrive nell'EventStore tramite l'host al posto di `webContents.send`. `sessioniPerConversazione` passa a `conversazione.sdk_session_id`. Nessun `WebContents` nella firma |
| `src/main/store.ts` | Resta solo per la migrazione, poi si toglie |
| **nuovo** `src/main/trasportoIpc.ts` | `jarai:busta` (invoke) + `jarai:evento` (send) |
| `src/preload/index.ts` | `window.jarai.host.{comando, richiesta, abbona}` al posto di `dati.*` e `claude.invia/onEvento` |
| `src/renderer/src/App.tsx` | Via `dati:salva` e il debounce. Lo stato arriva da un hook `useHost()` (snapshot + eventi + reducer) |
| `ConversazioneView.tsx`, `useStudioDigitale.ts` | Non assemblano più i messaggi: leggono la proiezione e inviano comandi |

---

## 9. Passi (una PR ciascuno)

1. **Electron ≥ 37**. Si verifica che dev, `dist:mac` e `dist:win` (dal Mac)
   funzionino ancora, compresi claude.exe e canvas.
   *Fatto quando:* l'installer Win parte su una VM, la chat risponde e l'OCR funziona.
2. **Protocollo + reducer** in `src/shared/`, con test unitari (vitest). ✅ `src/shared/protocollo/`, `src/shared/reducer.ts`, `npm test`.
   *Fatto quando:* applicando gli eventi di una conversazione reale si
   ottengono gli stessi `Messaggio[]` che produce oggi `ConversazioneView`.
3. **EventStore + migrazioni DB + migrazione JSON**. ✅ `src/core/{db,migrazioni,eventStore,migrazioneJson}.ts`. La rinomina di `jarai-dati.json` e l'avvio della migrazione all'apertura dell'app arrivano con il passo 4, insieme all'host.
   *Fatto quando:* un `jarai-dati.json` reale viene migrato e riletto senza
   perdite (test con fixture).
4. **Host + trasporto IPC + agentRunner sull'host**. ✅ Solo le conversazioni delle pratiche: lo Studio digitale passa all'host con il passo 5, insieme alle entità. `src/core/host.ts`, `src/main/hostDesktop.ts`, `src/renderer/src/host.ts`. Provato end-to-end con Claude vero: cambio vista a metà risposta e resume dopo riavvio. Le conversazioni (pratica
   e Studio digitale) passano dai comandi.
   *Fatto quando:* cambiando vista a metà risposta e tornando indietro la
   risposta è completa; chiudendo e riaprendo l'app la conversazione
   riprende con contesto (`resume`).
5. **Pratiche, documenti e Studio digitale sull'host**. ✅ Le viste modificano lo stato React come prima; `src/renderer/src/sincronizza.ts` manda all'host solo le differenze come comandi (`pratica.salva`, `documenti.salva`, `conversazioneSito.salva`…). I messaggi dello Studio digitale passano dall'host; la richiesta di idee resta una chiamata singola. `jarai-dati.json` viene rinominato dopo la migrazione. `dati:carica`/`dati:salva` e `store.ts` restano **solo come ripiego** se la migrazione fallisce (snapshot.entita = null): l'app non si apre mai vuota.
   *Fatto quando:* nel renderer non resta nessuna scrittura diretta di stato.
6. **Secondo client** ✅ Invece di una pagina di debug, il vero trasporto remoto: `src/core/trasportoWs.ts` (host via WebSocket, token per dispositivo, abbonamenti, battito) e `src/shared/clienteRemoto.ts` (cursore, riconnessione con recupero, gira in browser e Node). Test con due client remoti (`remoto.test.ts`); in sviluppo `JARAI_REMOTO_PROVA=1` apre il WebSocket su 127.0.0.1 con token casuale. Provato con Claude vero da uno script "telefono" in JSON puro. Nota: con `--remote-debugging-port` Electron intercetta le connessioni WebSocket del processo; senza quell'opzione (l'app normale) funziona.

Stima: 1,5-2 settimane. Il passo 1 è il più incerto.

---

## 10. Domande aperte

1. **Cifratura del DB a riposo** (§10.2): payload cifrati con una chiave in
   `safeStorage` adesso, oppure in un passo successivo?
2. **Delta nel log**: oggi non si persistono. Se servisse il replay
   "carattere per carattere" (es. per una demo), si possono salvare a blocchi
   ogni ~1 s.
3. **Conferme bloccanti (`canUseTool`)**: in questo passo ci sono solo tipi e
   reducer. Il flusso vero (§7) va fatto qui o insieme alla PWA?
4. **Spec §8.2**: aggiornarla con il `seq` globale e le tabelle `host` e `utente`?
