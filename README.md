# jarai.

L'assistente legale di Claude Code per lo studio — senza mai mostrare codice.
Specifica completa: [`../JarAI-Spec.md`](../JarAI-Spec.md).

## Stato attuale: Fase 3 in corso, con pezzi di Fase 2 e Fase 4 già completi

Fase 1 (Guscio) completa. Fase 2 (Collegamento a Claude) completa: streaming
reale, login ufficiale guidato con un solo pulsante "Collega Claude" (stile
T3 Code — due soli stati, collegato o no), stato persistito fra un riavvio e
l'altro. Fase 3 (Pratiche reali) in corso: la pratica nasce già legata 1:1 a
una cartella sul disco, con rilevamento di "Cartella non trovata" e "Trova di
nuovo" dopo uno spostamento; lettura reale estesa a DOC, RTF, MSG, P7M e OCR
delle immagini. Anticipato dalla Fase 4 (Motore legale): Claude legge davvero
i documenti della pratica selezionata. Vedi spec §12 per il piano completo.

Cosa c'è:

- Sidebar con marchio `jarai.`, elenco pratiche e conversazioni, navigazione.
- **Fai una domanda** — conversazione reale con Claude (`@anthropic-ai/claude-agent-sdk`),
  streaming del testo, piano di lavoro, fonti citate, richiesta di conferma
  inline. **Quando una pratica è selezionata, Claude può leggere davvero i
  suoi documenti** (PDF con testo diviso per pagina, DOCX, DOC, RTF, TXT,
  EML, MSG, P7M — con estrazione del contenuto firmato — immagini lette con
  OCR, **e audio trascritto** — telefonate, deposizioni registrate) tramite
  due strumenti MCP interni — `elenca_documenti` e `leggi_documento` (spec
  §6.2) — senza mai poter uscire dall'elenco dei documenti già indicizzati
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

**Lettura documenti — limiti attuali:** PDF, DOCX, DOC, RTF, TXT, EML, MSG,
P7M, immagini (JPG/PNG/GIF/WebP, con OCR italiano+inglese via `tesseract.js`)
e audio (MP3, M4A, WAV, OGG, AAC, FLAC, WMA) sono leggibili automaticamente.
L'OCR scarica i modelli lingua al primo uso (rete richiesta una volta sola,
poi restano in cache nella cartella dati) — **i PDF scansionati senza testo
non hanno ancora l'OCR delle pagine**, solo le immagini importate
singolarmente. Il testo di ogni documento è troncato a 60.000 caratteri e
letto una sola volta per conversazione (come in legis). Nessuna ricerca
full-text ancora (`cerca_nei_documenti` di spec §6.2 non c'è): il modello
deve sapere quale documento leggere, di solito dopo un `elenca_documenti`.

**File dentro uno ZIP** (fascicoli ricevuti dal tribunale o dalla
controparte, spesso zippati): quando lo scanner cartelle
(`src/main/pratiche.ts`) trova uno zip, chiede conferma ("Vuoi estrarlo?" —
scrivere su disco è sempre un'azione da confermare, spec §7) e in caso di sì
lo estrae in una cartella accanto all'originale, con lo stesso nome senza
`.zip` — esattamente come un doppio clic in Finder — **poi elimina lo zip
originale**, dichiarato nel testo della conferma prima di procedere. Da lì i
file estratti vengono indicizzati come qualunque altro documento della
pratica, quindi funzionano anche audio e P7M dentro uno zip. Se la cartella
di destinazione esiste già (zip già estratto ed eliminato in un giro
precedente) non richiede conferma una seconda volta. Un solo livello: uno
zip dentro un altro zip non viene proposto in automatico.

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

## Prossimi passi (spec §12)

1. **Pratiche reali** — resta l'OCR delle pagine scansionate nei PDF (oggi
   solo le immagini importate singolarmente hanno l'OCR).
2. **Motore legale** — fatto: `elenca_documenti`, `leggi_documento`,
   `crea_bozza` + salvataggio Word. Restano `cerca_nei_documenti`,
   `jarai-ricerca` (norme/giurisprudenza), `esporta_pdf`, assistenti
   specialisti, procedure, e la traduzione completa delle attività in chat
   (oggi solo "sto leggendo/guardando i documenti/preparando la bozza",
   generico — non ancora il nome del file).
3. **Controllo** — `PermissionGate` vero (oggi il salvataggio è già
   un'azione umana esplicita, ma senza un log strutturato), versioni delle
   bozze, pannello Modifiche, registro Attività in SQLite.
4. **Telefono** — relay Cloudflare, pairing QR, PWA.
