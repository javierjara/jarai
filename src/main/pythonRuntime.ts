import { app } from 'electron';
import { createWriteStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import { estraiZip } from './zip';
import { ambienteConPath, pathCompletoWindows } from './pathSistema';

// Bootstrap di un Python privato (spec §0.1 "zero terminale"): se sul PC
// dello studio non c'è già un Python 3 di sistema — la premessa che
// trascrizione.ts fa per la trascrizione audio — questo modulo può scaricare
// ed estrarre il pacchetto "embeddable" ufficiale di python.org, uno zip
// autosufficiente pensato apposta per essere distribuito accanto a
// un'applicazione: nessun installer, nessun permesso di amministratore,
// nessuna modifica al PATH di sistema. Stesso principio della venv privata
// già usata per faster-whisper, solo un livello più in basso: qui è Python
// stesso a essere privato, non solo l'ambiente con le librerie.
//
// Solo Windows: su macOS un Python 3 è quasi sempre già presente (Xcode
// Command Line Tools), e python.org non pubblica un pacchetto "embeddable"
// equivalente per quella piattaforma — lì un Python mancante resta un caso
// raro da risolvere con l'assistenza (messaggioErroreTrascrizione).
const VERSIONE_PYTHON = '3.12.7';
const URL_PYTHON_EMBED = `https://www.python.org/ftp/python/${VERSIONE_PYTHON}/python-${VERSIONE_PYTHON}-embed-amd64.zip`;
const URL_GET_PIP = 'https://bootstrap.pypa.io/get-pip.py';

const CARTELLA_PRIVATA = () => join(app.getPath('userData'), 'python-privato');
const ESEGUIBILE_PRIVATO = () => join(CARTELLA_PRIVATA(), 'python.exe');

export function installazionePrivataSupportata(): boolean {
  return process.platform === 'win32';
}

async function esiste(percorso: string): Promise<boolean> {
  try {
    await fs.access(percorso);
    return true;
  } catch {
    return false;
  }
}

export async function pythonPrivatoPresente(): Promise<boolean> {
  return installazionePrivataSupportata() && (await esiste(ESEGUIBILE_PRIVATO()));
}

// Un Python di sistema realmente funzionante, non solo "un file nel PATH":
// su Windows senza Python installato esiste comunque un "python.exe" civetta
// (quello di Microsoft Store) che si limita ad aprire la pagina per
// installarlo — utile distinguerlo da un vero interprete prima di fidarcene.
async function pythonSistemaFunzionante(): Promise<boolean> {
  const comando = process.platform === 'win32' ? 'python' : 'python3';
  const path = await pathCompletoWindows();
  return new Promise((resolve) => {
    const child = spawn(comando, ['--version'], { shell: process.platform === 'win32', env: ambienteConPath(path) });
    child.on('error', () => resolve(false));
    child.on('close', (codice) => resolve(codice === 0));
  });
}

// Quale interprete usare in questo momento, se ce n'è uno funzionante: prima
// il privato (se già installato in passato), altrimenti quello di sistema.
export async function eseguibilePythonAttivo(): Promise<{ percorso: string; privato: boolean } | null> {
  if (await pythonPrivatoPresente()) return { percorso: ESEGUIBILE_PRIVATO(), privato: true };
  if (await pythonSistemaFunzionante()) return { percorso: process.platform === 'win32' ? 'python' : 'python3', privato: false };
  return null;
}

function scarica(url: string, destinazione: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const richiedi = (urlCorrente: string, redirectResidui: number) => {
      https
        .get(urlCorrente, (res) => {
          const stato = res.statusCode ?? 0;
          if (stato >= 300 && stato < 400 && res.headers.location) {
            res.resume();
            if (redirectResidui <= 0) {
              reject(new Error('Troppi redirect nel download.'));
              return;
            }
            richiedi(new URL(res.headers.location, urlCorrente).toString(), redirectResidui - 1);
            return;
          }
          if (stato !== 200) {
            res.resume();
            reject(new Error(`Download fallito (codice ${stato}).`));
            return;
          }
          const file = createWriteStream(destinazione);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    richiedi(url, 5);
  });
}

function eseguiComando(comando: string, argomenti: string[]): Promise<{ codice: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(comando, argomenti);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (codice) => resolve({ codice, stderr }));
  });
}

export type FaseInstallazionePython = 'download-python' | 'estrazione' | 'download-pip' | 'installazione-pip' | 'completato';

// Scarica ed estrae il Python privato, poi gli abilita pip — il pacchetto
// "embeddable" nasce senza, serve per poter installare faster-whisper subito
// dopo (trascrizione.ts). Ogni passo fallito ripulisce la cartella invece di
// lasciarla a metà: altrimenti il tentativo successivo la troverebbe
// "presente" (l'eseguibile python.exe c'è) ma incapace di installare nulla.
export async function installaPythonPrivato(onFase?: (fase: FaseInstallazionePython) => void): Promise<void> {
  if (!installazionePrivataSupportata()) {
    throw new Error('Questa installazione automatica è disponibile solo su Windows.');
  }
  const cartella = CARTELLA_PRIVATA();
  await fs.rm(cartella, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(cartella, { recursive: true });

  try {
    onFase?.('download-python');
    const zipPath = join(app.getPath('temp'), 'jarai-python-embed.zip');
    await scarica(URL_PYTHON_EMBED, zipPath);

    onFase?.('estrazione');
    await estraiZip(zipPath, cartella);
    await fs.unlink(zipPath).catch(() => undefined);

    // Il pacchetto embeddable disabilita di norma "import site" (niente
    // site-packages, per restare minuscolo): senza riabilitarla, i pacchetti
    // che pip installerà tra un attimo non sarebbero mai importabili.
    const fileConfig = (await fs.readdir(cartella)).find((f) => f.endsWith('._pth'));
    if (fileConfig) {
      const percorsoConfig = join(cartella, fileConfig);
      const contenuto = await fs.readFile(percorsoConfig, 'utf-8');
      await fs.writeFile(percorsoConfig, contenuto.replace(/^#\s*import site/m, 'import site'));
    }

    onFase?.('download-pip');
    const getPipPath = join(cartella, 'get-pip.py');
    await scarica(URL_GET_PIP, getPipPath);

    onFase?.('installazione-pip');
    const pip = await eseguiComando(ESEGUIBILE_PRIVATO(), [getPipPath, '--quiet', '--no-warn-script-location']);
    await fs.unlink(getPipPath).catch(() => undefined);
    if (pip.codice !== 0) throw new Error(pip.stderr || `pip non installato (uscita ${pip.codice})`);

    onFase?.('completato');
  } catch (err) {
    await fs.rm(cartella, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
