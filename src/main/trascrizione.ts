import { app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { generaDocxBuffer } from './bozze';
import { ambienteConPath, pathCompletoWindows } from './pathSistema';
import { eseguibilePythonAttivo } from './pythonRuntime';

// Trascrizione audio (spec §6.2, Fase 3): un processo Python esterno con
// faster-whisper, sullo stesso schema del CLI "claude" già usato per il
// login (src/main/claudeLogin.ts) — nessuna libreria pesante impacchettata
// dentro JarAI. La qualità del parlato reale (telefonate, deposizioni) ha
// bisogno di un modello vero, non di quello minuscolo pensato per un
// browser: da qui la scelta di un processo Python invece di una libreria
// JavaScript in-process.
//
// Spec §0.1 vieta però di far mai aprire un terminale all'avvocato: JarAI si
// prepara da sola un ambiente Python tutto suo (una venv dentro i dati
// dell'app, mai quello di sistema) e ci installa faster-whisper al primo
// utilizzo, senza che l'avvocato debba digitare "pip install" da nessuna
// parte. L'unica cosa che deve già esserci sul computer è Python 3 stesso
// (di serie o via Xcode Command Line Tools su macOS) — quello non si può
// installare da soli senza un vero installer di sistema.
// In sviluppo lo script sta dentro il progetto; impacchettata, l'app.asar
// non è un percorso reale che un processo Python esterno possa leggere —
// electron-builder lo copia accanto alle altre risorse (extraResources), da
// lì si legge con process.resourcesPath invece di app.getAppPath().
const SCRIPT_PATH = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'resources', 'trascrivi.py')
    : join(app.getAppPath(), 'resources', 'trascrivi.py');
const CACHE_PATH = () => join(app.getPath('userData'), 'audio-trascrizioni-cache.json');
const AMBIENTE_DIR = () => join(app.getPath('userData'), 'python-audio-env');
// Il percorso dentro la venv differisce su Windows (l'eseguibile sta in
// "Scripts\python.exe", non "bin/python3").
const PYTHON_VENV = () =>
  process.platform === 'win32' ? join(AMBIENTE_DIR(), 'Scripts', 'python.exe') : join(AMBIENTE_DIR(), 'bin', 'python3');

function messaggioErroreTrascrizione(testoGrezzo: string): string {
  if (/enoent|not found|command not found/i.test(testoGrezzo)) {
    return 'Serve Python 3 su questo computer per trascrivere gli audio — su Windows puoi installarlo da Impostazioni → Trascrizione audio, altrimenti chiedi al tuo tecnico.';
  }
  if (/permission denied/i.test(testoGrezzo)) {
    return 'Non riesco a preparare l\'ambiente per la trascrizione (permessi del sistema). Contatta il tuo tecnico.';
  }
  return 'Non sono riuscito a preparare la trascrizione audio: verifica di avere una connessione internet (serve solo la prima volta) e riprova.';
}

async function eseguiComando(comando: string, argomenti: string[]): Promise<{ codice: number | null; stdout: string; stderr: string }> {
  // Stesso motivo di claudeLogin.ts: su Windows un'app avviata con un
  // doppio clic può ereditare un PATH più corto o più vecchio di quello
  // visto in un terminale aperto a mano — "python" può risultare non
  // trovato anche quando è davvero installato. Qui in più "python" è quasi
  // sempre uno script/shim, non un .exe nudo: senza `shell: true` Node non
  // lo troverebbe comunque.
  const path = await pathCompletoWindows();
  return new Promise((resolve, reject) => {
    const child = spawn(comando, argomenti, { shell: process.platform === 'win32', env: ambienteConPath(path) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (codice) => resolve({ codice, stdout, stderr }));
  });
}

async function esiste(percorso: string): Promise<boolean> {
  try {
    await fs.access(percorso);
    return true;
  } catch {
    return false;
  }
}

let ambientePronto: Promise<string> | null = null;

// Prepara (una sola volta per avvio dell'app) l'ambiente Python dedicato:
// se la venv con faster-whisper già dentro esiste, la riusa; altrimenti la
// crea e ci installa la libreria — l'unica volta che serve una connessione
// a internet. Ritorna il percorso dell'eseguibile Python da usare.
function assicuraAmbiente(): Promise<string> {
  if (!ambientePronto) {
    // Se la preparazione fallisce (es. rete assente in quel momento), non
    // resta bloccata per il resto della sessione: il prossimo tentativo la
    // rifà da capo invece di ripetere per sempre lo stesso errore.
    ambientePronto = creaAmbiente().catch((err) => {
      ambientePronto = null;
      throw err;
    });
  }
  return ambientePronto;
}

async function pacchettoInstallato(python: string, nomeModulo: string): Promise<boolean> {
  const { codice } = await eseguiComando(python, ['-c', `import ${nomeModulo}`]).catch(() => ({ codice: 1 }));
  return codice === 0;
}

async function creaAmbiente(): Promise<string> {
  const attivo = await eseguibilePythonAttivo();
  if (!attivo) {
    throw new Error(messaggioErroreTrascrizione('not found'));
  }

  // Python privato (scaricato da Impostazioni → Trascrizione audio, spec
  // §12): è già un ambiente isolato tutto suo, mai quello di sistema — a
  // differenza del caso sotto non serve un'altra venv sopra, faster-whisper
  // si installa direttamente lì.
  if (attivo.privato) {
    if (await pacchettoInstallato(attivo.percorso, 'faster_whisper')) return attivo.percorso;
    const pip = await eseguiComando(attivo.percorso, [
      '-m',
      'pip',
      'install',
      '--quiet',
      '--disable-pip-version-check',
      'faster-whisper',
    ]).catch((err) => {
      throw new Error(messaggioErroreTrascrizione(err.message));
    });
    if (pip.codice !== 0) throw new Error(messaggioErroreTrascrizione(pip.stderr || `uscita ${pip.codice}`));
    return attivo.percorso;
  }

  const pythonVenv = PYTHON_VENV();
  if (await esiste(pythonVenv)) return pythonVenv;

  const venv = await eseguiComando(attivo.percorso, ['-m', 'venv', AMBIENTE_DIR()]).catch((err) => {
    throw new Error(messaggioErroreTrascrizione(err.message));
  });
  if (venv.codice !== 0) {
    throw new Error(messaggioErroreTrascrizione(venv.stderr || `uscita ${venv.codice}`));
  }

  const pip = await eseguiComando(pythonVenv, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'faster-whisper']).catch((err) => {
    throw new Error(messaggioErroreTrascrizione(err.message));
  });
  if (pip.codice !== 0) {
    // L'ambiente è a metà: lo ripuliamo, altrimenti il prossimo tentativo lo
    // troverebbe "pronto" (l'eseguibile python c'è) ma senza faster-whisper.
    await fs.rm(AMBIENTE_DIR(), { recursive: true, force: true }).catch(() => undefined);
    throw new Error(messaggioErroreTrascrizione(pip.stderr || `uscita ${pip.codice}`));
  }

  return pythonVenv;
}

type Cache = Record<string, string>;

async function leggiCache(): Promise<Cache> {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH(), 'utf-8'));
  } catch {
    return {};
  }
}

async function scriviCache(cache: Cache): Promise<void> {
  await fs.writeFile(CACHE_PATH(), JSON.stringify(cache));
}

// Chiave stabile su percorso + dimensione + data di modifica: se il file
// cambia (o viene sostituito con uno nuovo con lo stesso nome) la cache non
// restituisce un testo ormai sbagliato.
function chiaveCache(percorso: string, dimensione: number, modificatoIlMs: number): string {
  return `${percorso}::${dimensione}::${modificatoIlMs}`;
}

async function eseguiScript(pythonVenv: string, percorsoAudio: string): Promise<string> {
  const { codice, stdout, stderr } = await eseguiComando(pythonVenv, [SCRIPT_PATH(), percorsoAudio]);
  if (codice !== 0) {
    throw new Error(messaggioErroreTrascrizione(stderr));
  }
  try {
    const risultato = JSON.parse(stdout.trim()) as { text?: string };
    return risultato.text ?? '';
  } catch {
    throw new Error('La trascrizione ha restituito una risposta non valida.');
  }
}

function percorsoFileTrascrizione(cartellaPratica: string, nomeAudio: string): string {
  const nomeBase = basename(nomeAudio, extname(nomeAudio)).replace(/[/\\:*?"<>|]/g, ' ').trim();
  return join(cartellaPratica, 'JarAI - Bozze', `${nomeBase} — trascrizione.docx`);
}

// Salva subito la trascrizione come vero file Word dentro "JarAI - Bozze"
// (spec §8.1: `{cartella pratica}/JarAI - Bozze/`) — automatico, non
// un'azione da confermare: resta comunque solo nella sottocartella delle
// bozze, mai sugli originali dell'avvocato (spec §0.3). Senza questo, il
// testo trascritto esisterebbe solo nella cache interna dell'app, non
// riapribile né allegabile a un atto. Chiamata anche su una lettura dalla
// cache (non solo su una trascrizione nuova), per riparare da sola i file
// creati prima che questo salvataggio esistesse, o cancellati per sbaglio.
async function assicuraFileTrascrizione(cartellaPratica: string, nomeAudio: string, testo: string): Promise<void> {
  const percorsoFile = percorsoFileTrascrizione(cartellaPratica, nomeAudio);
  if (await esiste(percorsoFile)) return;
  await fs.mkdir(join(cartellaPratica, 'JarAI - Bozze'), { recursive: true });
  const nomeBase = basename(nomeAudio, extname(nomeAudio));
  const markdown = `## Trascrizione — ${nomeBase}\n\n${testo}`;
  const buffer = await generaDocxBuffer(markdown);
  await fs.writeFile(percorsoFile, buffer);
}

// Un audio lungo (una deposizione, una telefonata intera) può richiedere
// minuti reali di trascrizione: la cache su disco evita di rifare tutto il
// lavoro se lo stesso file viene letto di nuovo in una conversazione futura
// (il dedup in documentTools.ts copre solo la conversazione corrente).
export async function trascriviAudio(percorso: string, cartellaPratica: string | null, nomeFile: string): Promise<string> {
  const stat = await fs.stat(percorso);
  const chiave = chiaveCache(percorso, stat.size, stat.mtimeMs);
  const cache = await leggiCache();
  let testo = cache[chiave];

  if (testo === undefined) {
    const pythonVenv = await assicuraAmbiente();
    testo = await eseguiScript(pythonVenv, percorso);
    cache[chiave] = testo;
    await scriviCache(cache);
  }

  if (cartellaPratica) {
    // Il file salvato non deve mai far fallire la lettura in chat: se il
    // salvataggio va storto (permessi, disco pieno...) Claude ha comunque
    // già il testo da usare, l'avvocato lo saprà dal messaggio di errore
    // solo se anche la lettura fallisce per un altro motivo.
    await assicuraFileTrascrizione(cartellaPratica, nomeFile, testo).catch(() => undefined);
  }

  return testo;
}
