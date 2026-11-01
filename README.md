# jarai

L'assistente legale di Claude Code per lo studio — senza mai mostrare codice.
Specifica completa: [`../JarAI-Spec.md`](../JarAI-Spec.md).

## Stato attuale: Fase 3 completa, con pezzi di Fase 2 e Fase 4 già completi

Fase 1 (Guscio) completa. Fase 2 (Collegamento a Claude) completa: streaming
reale, login ufficiale guidato con un solo pulsante "Collega Claude" (stile
T3 Code — due soli stati, collegato o no), stato persistito fra un riavvio e
l'altro. Fase 3 (Pratiche reali) **completa**: la pratica nasce già legata
1:1 a una cartella sul disco, con rilevamento di "Cartella non trovata" e
"Trova di nuovo" dopo uno spostamento; lettura reale estesa a DOC, RTF, MSG,
P7M, OCR delle immagini **e OCR delle pagine scansionate nei PDF** (fino a
1000 pagine scansionate per documento), con **indice in background** di tutti
i documenti appena importati, zip compresi.
Anticipato dalla Fase 4 (Motore legale): Claude legge davvero i documenti
della pratica selezionata. Vedi spec §12 per il piano completo.

Cosa c'è:

- Sidebar con marchio `jarai`, elenco pratiche e conversazioni, navigazione.
- **Fai una domanda** — conversazione reale con Claude (`@anthropic-ai/claude-agent-sdk`),
  streaming del testo, piano di lavoro, fonti citate, richiesta di conferma
  inline. **Quando una pratica è selezionata, Claude può leggere davvero i
  suoi documenti** (PDF con testo diviso per pagina, DOCX, DOC, RTF, TXT,
  EML, MSG, P7M — con estrazione del contenuto firmato — immagini lette con
  OCR, **e audio trascritto** — telefonate, deposizioni registrate) tramite
  tre strumenti MCP interni — `elenca_documenti`, `leggi_documento` e
  `cerca_nei_documenti` (spec §6.2) — senza mai poter uscire dall'elenco dei documenti già indicizzati
  della pratica. Nessun altro strumento nativo (Bash/Write/Edit) è concesso.
  Può anche **proporre bozze vere** (`crea_bozza`, spec §6.2): quando chiedi
  di redigere un atto compare un "📄 documento pronto" nella chat, che apre
  un'anteprima e un pulsante **"Salva in Word"** — genera un vero `.docx`
  (titoli, grassetto, elenchi) dove scegli tu. Non salva nulla da solo: il
  salvataggio è sempre un'azione esplicita dell'avvocato, mai autonoma del
  modello.
- **Storico** — filtro per pratica e per "in attesa di conferma".
- **Le mie pratiche** — porting della Libreria di legis: sidebar pratiche
  ridimensionabile, elenco documenti con anteprima. **Ogni pratica è legata
  1:1 a una cartella del disco** (spec §5.3): "Aggiungi pratica" apre subito
  il selettore e indicizza tutto; "Aggiorna dalla cartella" rilegge la stessa
  cartella per scoprire i file nuovi (modale con Nuovi/Già presenti); se la
  cartella è stata rinominata o spostata compare "Cartella non trovata" con
  "Trova di nuovo". "Apri nella cartella" per i singoli documenti.
- **Persistenza locale** — pratiche, documenti e conversazioni sopravvivono
  alla chiusura dell'app: salvati in `jarai-dati.json` nella cartella dati
  di Electron (`app.getPath('userData')`), validati con zod al caricamento.
  In attesa di SQLite (spec §8.2, Fase 5) — stessa forma dei dati, cambia
  solo dove vengono letti/scritti.
- **Impostazioni** — studio, **collegamento Claude reale**: un solo pulsante
  "Collega Claude" (login ufficiale, stesso `claude auth login` di T3 Code —
  apre il browser, chiede il codice da incollare, verifica da sola a fine
  accesso) e "Disconnetti"; procedure, privacy, telefono. La chiave API dello
  studio e il login Console/Team restano supportati lato codice ma non sono
  più nella UI (si riespongono facilmente in un pannello avanzato se serve).

Sicurezza già definitiva (spec §2.3): `contextIsolation`, `sandbox`,
`nodeIntegration: false`, CSP rigorosa in produzione, whitelist di canali IPC
con validazione zod, niente `webview`, niente finestre esterne non gestite.

**Isolamento dell'accesso a Claude (spec §3):** JarAI punta
`CLAUDE_CONFIG_DIR` su una cartella propria dentro i dati dell'app, mai su
`~/.claude` dell'avvocato — un suo uso personale di Claude Code sullo stesso
computer resta separato, sia con la chiave sia con il login guidato.

**Lettura documenti — limiti attuali:** PDF (testuale e scansionato), DOCX,
DOC, RTF, TXT, EML, MSG, P7M, immagini (JPG/PNG/GIF/WebP, con OCR
italiano+inglese via `tesseract.js`) e audio (MP3, M4A, WAV, OGG, AAC, FLAC,
WMA) sono leggibili automaticamente. Nei PDF, le pagine senza un layer di
testo (sotto i 20 caratteri) vengono riconosciute come scansionate e lette
con lo stesso OCR, a blocchi di 10 pagine per contenere la memoria (tetto di
protezione a 1000 pagine scansionate per documento).
L'OCR scarica i modelli lingua al primo uso (rete richiesta una volta sola,
poi restano in cache nella cartella dati).

**Indice in background (`src/main/indice.ts`):** appena una cartella viene
importata o aggiornata, tutti i documenti leggibili (audio esclusi) vengono
estratti uno alla volta e il testo resta in cache in `indice-testi/` nella
cartella dati, con una chiave da percorso + dimensione + data di modifica (un
file cambiato si reindicizza da solo). La vista pratiche mostra "Sto
preparando i documenti per la lettura: N di M". Quando Claude chiede un
documento il testo è già pronto; se l'indice lo sta ancora estraendo, la
lettura si aggancia allo stesso lavoro. Anche l'invio di una domanda mette in
coda i documenti non ancora indicizzati (pratiche importate prima dell'indice).

**Lettura completa della pratica:** il prompt chiede di leggere *tutti* i
documenti leggibili alla prima domanda e di dichiarare per nome quelli che non
si sono potuti leggere. Niente più troncamento: i documenti oltre 60.000
caratteri si leggono a parti (`leggi_documento` con `parte`, "Parte N di M").
Le letture ripetute nella stessa conversazione restano deduplicate per parte,
ma con `rileggi: true` il modello può rileggere un testo uscito dal contesto.
`maxTurns` cresce con il numero di documenti (20 + 3 per documento, fino a
300). `cerca_nei_documenti` cerca una parola o frase in tutta la pratica
(senza distinguere maiuscole e accenti) e restituisce i brani con documento e
pagina.

**Strumenti ed efficienza (token):** `elenca_documenti` mostra per ogni
documento pagine, peso stimato in token e numero di parti, così Claude
pianifica le letture. `leggi_documento` accetta `pagine` ("12" o "12-15")
per verificare un passaggio senza rileggere una parte intera.
`cerca_nei_documenti` accetta più termini in una sola chiamata, con tetti per
termine e per documento. `estrai_date` restituisce in ordine cronologico tutte
le date della pratica (numeriche o per esteso) con documento, pagina e
contesto: la base per cronologie e scadenze, calcolata in locale a costo zero.
Il prompt chiede letture in parallelo (meno passaggi, quindi meno contesto
rimandato), effort `medium` per Standard e `high` per Massima, e con la
licenza JarAI un tetto di spesa per domanda (`maxBudgetUsd`: $8 Standard, $20
Massima). Turni o tetto esauriti mostrano un messaggio chiaro all'avvocato,
non più "Non riesco a raggiungere Claude".

**Memoria della pratica** (`src/main/memoriaPratica.ts`, strumenti
`leggi_memoria_pratica` e `salva_in_memoria_pratica`): dopo aver letto per
intero un documento Claude ne salva una scheda (tipo di atto, parti, date,
importi, punti chiave con le pagine), più i fatti stabili della pratica. La
conversazione successiva parte dalle schede e legge per intero solo i
documenti senza scheda o modificati (impronta dimensione + data di modifica),
tornando sul testo per i dettagli. Una scheda si accetta solo se in quella
conversazione il documento è stato letto davvero tutto, parte per parte. La
memoria resta sul computer (`memoria-pratiche/` nella cartella dati di JarAI)
e si cancella insieme alla pratica.

**Prompt di sistema:** con una chiave API (dello studio o dietro la licenza
JarAI) si usa solo il prompt legale più la data di oggi, senza il preset
`claude_code` (migliaia di token di istruzioni per programmare a ogni
passaggio). Con l'accesso tramite account Claude il preset resta.

**Modelli:** Standard = `claude-sonnet-5`, Massima = `claude-opus-5-5`
(meno caro di Opus 5). Il proxy deve avere `claude-opus-5-5` in
`ALLOWED_MODELS` **prima** di distribuire questa versione dell'app.

**File dentro uno ZIP** (fascicoli ricevuti dal tribunale o dalla
controparte, spesso zippati): lo scanner cartelle (`src/main/pratiche.ts`)
estrae sempre lo zip, senza chiedere, in `zip-estratti/` nella cartella dati
di JarAI — mai nella cartella dell'avvocato, e lo zip originale non viene
toccato. I documenti estratti compaiono come "Fascicolo.zip/Atti" e si
indicizzano come tutti gli altri; gli zip dentro uno zip vengono letti allo
stesso modo, a ogni livello. Uno zip già estratto (stesso percorso, dimensione
e data) non si riestrae. Gli audio dentro uno zip si trascrivono, ma la
trascrizione .docx non viene salvata in "JarAI - Bozze" perché non hanno una
cartella della pratica accanto.

**Trascrizione audio — richiede Python (spec §12, Fase 3):** a differenza
degli altri formati, l'audio non usa una libreria JavaScript in-process ma un
processo Python esterno con [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(`resources/trascrivi.py`, spawnato da `src/main/trascrizione.ts`) — stesso
schema del CLI `claude` già richiesto per il login. La scelta è voluta: i
modelli Whisper piccoli abbastanza per girare in JavaScript nel browser danno
una qualità inaccettabile su audio reale (telefonate, non registrazioni
pulite in studio) — testato con l'audio reale di una telefonata,
`faster-whisper` con il modello `medium` capisce l'intera conversazione anche
nei tratti difficili, la libreria JS equivalente inventava frasi nei primi
secondi. Il modello `medium` gira su CPU a circa 0,35-0,5× la durata
dell'audio (una telefonata di 44 secondi trascritta in 16 secondi) — una
registrazione lunga (una deposizione di un'ora) richiede quindi diversi
minuti reali.

Coerente con "zero terminale" (spec §0.1): serve solo Python 3 già presente
sul computer (`python3` nel PATH) — JarAI si prepara da sola una venv privata
dentro i dati dell'app (`python-audio-env/`) e ci installa `faster-whisper`
al primo utilizzo, senza che l'avvocato digiti alcun comando. Ogni audio
trascritto resta in cache (`audio-trascrizioni-cache.json` nella cartella
dati, chiave su percorso + dimensione + data di modifica) così non va
ritrascritto in conversazioni successive, **e viene salvato subito come vero
file Word** in `{cartella pratica}/JarAI - Bozze/{nome audio} — trascrizione.docx`
(spec §8.1) — automatico, non un'azione da confermare, ma resta comunque
confinato alla sottocartella delle bozze, mai sugli originali (spec §0.3).

## Sviluppo

```bash
npm install
npm run dev        # avvia l'app Electron in sviluppo
npm run typecheck
npm run build       # build di produzione (main + preload + renderer)
```

Per provare il collegamento a Claude: Impostazioni → Collegamento Claude →
incolla una chiave API Anthropic (`sk-ant-…`) e Salva, **oppure** "Accedi
con l'account" per il login ufficiale guidato. Ogni verifica e ogni
messaggio inviato è una vera richiesta a Claude (costo reale, minimo).

## Rilasciare una nuova versione

Gli aggiornamenti si distribuiscono via GitHub Releases, su un repo
**separato** da questo (solo installer, niente codice sorgente):
[`javierjara/jarai-releases`](https://github.com/javierjara/jarai-releases)
(pubblico — deve esserlo, altrimenti `electron-updater` dentro l'app
avrebbe bisogno di un token per scaricare, cosa che non vogliamo
incorporare in un'app distribuita). La sezione `build.publish` di
`package.json` punta già lì.

1. **Alza la versione** in `package.json` (`"version"`) — `electron-builder`
   usa questo numero per il tag della release e per il confronto che fa
   `electron-updater` dentro l'app (spec §12, `src/main/aggiornamenti.ts`).
2. **Genera un token GitHub** (una volta sola, poi scade e va rifatto):
   [github.com/settings/tokens](https://github.com/settings/tokens) →
   fine-grained → repository access solo su `jarai-releases` → permesso
   "Contents: Read and write". Non va mai incollato in chat né committato.
3. **Pubblica**:
   ```bash
   export GH_TOKEN=il_tuo_token
   npm run release:win   # Windows — genera anche release:mac per macOS
   ```
   Questo builda e carica su `jarai-releases` l'installer, il `.blockmap`
   e il manifest (`latest.yml` / `latest-mac.yml`) che `electron-updater`
   legge per sapere se c'è una versione più recente.
4. **La release nasce in bozza (Draft)** — apri
   [i Releases](https://github.com/javierjara/jarai-releases/releases),
   controlla che gli allegati ci siano tutti, poi "Edit" → "Publish
   release". Finché resta Draft, `electron-updater` non la vede (l'API di
   GitHub la esclude di proposito).
5. Da quel momento, chi ha l'app installata la trova da **Impostazioni →
   Aggiornamenti → "Cerca aggiornamenti"** — mai un controllo automatico
   all'avvio, sempre un gesto esplicito dell'avvocato (stesso principio di
   ogni altra azione di jarai).

Per aggiungere anche gli asset macOS alla stessa release (stesso numero di
versione): `npm run release:mac` — electron-builder li accoda a quella già
esistente invece di crearne una nuova.

## Prossimi passi (spec §12)

Fase 3 (Pratiche reali) è completa — vedi "Stato attuale" sopra.

1. **Motore legale** — fatto: `elenca_documenti`, `leggi_documento`,
   `cerca_nei_documenti`, `crea_bozza` + salvataggio Word. Restano
   `jarai-ricerca` (norme/giurisprudenza), `esporta_pdf`, assistenti
   specialisti, procedure, e la traduzione completa delle attività in chat
   (oggi solo "sto leggendo/guardando i documenti/preparando la bozza",
   generico — non ancora il nome del file).
2. **Controllo** — `PermissionGate` vero (oggi il salvataggio è già
   un'azione umana esplicita, ma senza un log strutturato), versioni delle
   bozze, pannello Modifiche, registro Attività in SQLite.
3. **Telefono** — relay Cloudflare, pairing QR, PWA.
4. **Motore proprietario** (Fase 8, spec §12, §15 domanda 5) — sostituire
   `@anthropic-ai/claude-agent-sdk` con un motore su `@anthropic-ai/sdk` +
   `@modelcontextprotocol/sdk` diretti, condizione per vendere la modalità
   Licenza JarAI (`jarai-proxy`) senza l'approvazione esplicita di
   Anthropic. Non blocca lo sviluppo attuale, solo le vendite sul serio.
5. **Firma dell'installer Windows** (spec §12, Fase 7 "Rifinitura") — oggi
   `dist:win`/`release:win` saltano la firma ("no signing info identified"),
   quindi chi scarica l'installer vede l'avviso "PC protetto da Windows"
   (Microsoft Defender SmartScreen) prima di poterlo eseguire — per il
   pubblico di jarai (avvocati non tecnici) è un ostacolo reale alla prima
   installazione, non solo estetico. Verificato: serve un certificato di
   code signing, non più un semplice file `.pfx` (dal 2023 il CA/Browser
   Forum impone che la chiave privata stia su hardware certificato — una
   chiavetta USB o un servizio di firma cloud). Opzione scelta: **Azure
   Trusted Signing** (ora "Azure Artifact Signing") — ~120€/anno (piano
   Basic, 5.000 firme/mese), tutto cloud (nessuna chiavetta da tenere
   collegata al Mac di sviluppo), ed è il sistema di fiducia di Microsoft
   stesso che alimenta direttamente SmartScreen, quindi elimina l'avviso da
   subito — a differenza di un certificato OV economico, la cui reputazione
   si costruisce solo con il tempo e i download. Alternativa più cara ma
   "portabile" (non legata all'ecosistema Microsoft): un certificato EV
   tradizionale (DigiCert, SSL.com…), 300-900€/anno. Da marzo 2026 entrambi
   i tipi durano al massimo 460 giorni: il rinnovo va messo in calendario,
   non è più "una volta e basta" come i vecchi certificati triennali.
   **Prossimo passo pratico**: attivare un abbonamento Azure Trusted
   Signing (richiede una verifica d'identità, qualche giorno la prima
   volta), poi collegare `electron-builder` (`win.sign` / `azureSignOptions`
   nella config di `package.json`) così `release:win` firma da solo a ogni
   pubblicazione.
