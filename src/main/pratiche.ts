import { dialog, ipcMain, protocol, shell, type BrowserWindow } from 'electron';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, basename, dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { CARTELLA_PRINCIPALE, ESTENSIONI_AUDIO, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';
import { estraiZip } from './zip';

export { CARTELLA_PRINCIPALE };

// Formati supportati dallo studio legale (spec §6.2). Le sottocartelle vengono
// lette ricorsivamente, come "Atti", "Contratti", "Corrispondenza" nella vista
// di una pratica reale.
const ESTENSIONI_SUPPORTATE = ESTENSIONI_LEGGIBILI;

interface FileTrovato {
  nome: string;
  percorso: string;
  cartella: string;
  estensione: string;
  dimensione: number;
  modificatoIl: string;
}

async function esisteCartella(percorso: string): Promise<boolean> {
  try {
    return (await fs.stat(percorso)).isDirectory();
  } catch {
    return false;
  }
}

// Zip trovato durante l'importazione: chiede conferma prima di estrarlo
// (spec §7, livello "Conferma" — scrivere su disco non è mai automatico) e
// lo estrae accanto all'originale, come farebbe Finder. Se una cartella con
// lo stesso nome esiste già, si assume già estratto in precedenza e non
// richiede conferma una seconda volta a ogni "Aggiorna dalla cartella".
async function gestisciZip(percorsoZip: string, nomeZip: string, win: BrowserWindow | null): Promise<string | null> {
  const destDir = join(dirname(percorsoZip), basename(nomeZip, '.zip'));
  if (await esisteCartella(destDir)) return destDir;

  const opzioni = {
    type: 'question' as const,
    buttons: ['Estrai', 'Ignora'],
    defaultId: 0,
    cancelId: 1,
    message: `È stato trovato l'archivio «${nomeZip}»`,
    detail:
      'Vuoi estrarlo per includere i documenti al suo interno nella pratica? Viene creata una cartella accanto allo zip con lo stesso nome, poi lo zip originale viene eliminato.',
  };
  const risposta = win ? await dialog.showMessageBox(win, opzioni) : await dialog.showMessageBox(opzioni);
  if (risposta.response !== 0) return null;

  try {
    await estraiZip(percorsoZip, destDir);
  } catch {
    return null; // Zip corrotto o protetto da password: viene saltato, non blocca il resto della pratica.
  }

  // Lo zip originale viene rimosso solo dopo un'estrazione riuscita — se
  // l'eliminazione fallisce (permessi...) i documenti restano comunque
  // utilizzabili dalla cartella appena creata, non è un errore bloccante.
  await fs.unlink(percorsoZip).catch(() => undefined);
  return destDir;
}

async function leggiCartellaRicorsiva(dirPath: string, baseDir: string, win: BrowserWindow | null): Promise<FileTrovato[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const risultati: FileTrovato[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      risultati.push(...(await leggiCartellaRicorsiva(fullPath, baseDir, win)));
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = extname(entry.name).slice(1).toLowerCase();
    const rel = relative(baseDir, dirPath);
    const cartella = rel === '' ? CARTELLA_PRINCIPALE : rel;

    if (ext === 'zip') {
      const destDir = await gestisciZip(fullPath, entry.name, win);
      if (destDir) risultati.push(...(await leggiCartellaRicorsiva(destDir, baseDir, win)));
      continue;
    }

    if (!ESTENSIONI_SUPPORTATE.has(ext)) continue;

    try {
      const stat = await fs.stat(fullPath);
      risultati.push({
        nome: entry.name,
        percorso: fullPath,
        cartella,
        estensione: ext.toUpperCase(),
        dimensione: stat.size,
        modificatoIl: stat.mtime.toISOString(),
      });
    } catch {
      // File non leggibile (permessi, link rotto...): viene semplicemente saltato.
    }
  }

  return risultati;
}

const percorsoSchema = z.string().min(1);
const percorsiSchema = z.array(z.string().min(1));

// Tipo MIME per ogni estensione audio supportata — senza un Content-Type
// corretto Chromium a volte rifiuta di riprodurre il file anche se i byte
// sono giusti.
const MIME_AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
};

// Player audio in pratica (spec §6.2): serve il file al tag <audio> del
// renderer via un protocollo dedicato invece di leggerlo a mano e spedirlo
// come Buffer sopra IPC — quella strada è pensata per messaggi piccoli, non
// per file audio da decine di MB, ed è un punto fragile (nessuna ricerca nel
// player, tutto il file in memoria prima ancora di sentirne un secondo).
//
// La richiesta "Range" (per cercare un punto preciso) viene gestita a mano
// qui, invece di affidarsi a un net.fetch su file:// e sperare che la
// inoltri da solo: con un tentativo precedente (net.fetch con gli header
// della richiesta originale inoltrati) il seek nel player non funzionava —
// affidabile al 100% solo leggendo noi stessi l'intervallo di byte richiesto
// e rispondendo con lo status HTTP giusto (206 Partial Content), esattamente
// come farebbe un vero server che serve file. Solo le estensioni audio note
// sono ammesse — mai un lettore di file generico esposto al renderer.
export function registraProtocolloAudio(): void {
  protocol.handle('jarai-media', async (request) => {
    try {
      const percorso = decodeURIComponent(new URL(request.url).searchParams.get('p') ?? '');
      const ext = extname(percorso).slice(1).toLowerCase();
      if (!percorso || !ESTENSIONI_AUDIO.has(ext)) {
        return new Response('Formato audio non supportato.', { status: 403 });
      }

      const stat = await fs.stat(percorso);
      const dimensione = stat.size;
      const tipo = MIME_AUDIO[ext] ?? 'application/octet-stream';
      const rangeHeader = request.headers.get('Range');

      if (!rangeHeader) {
        // Prima richiesta, senza Range: tutto il file, ma "Accept-Ranges"
        // dice al browser che può chiedere un intervallo più avanti — è
        // quello che permette poi il seek.
        const corpo = Readable.toWeb(createReadStream(percorso)) as ReadableStream<Uint8Array>;
        return new Response(corpo, {
          status: 200,
          headers: { 'Content-Type': tipo, 'Content-Length': String(dimensione), 'Accept-Ranges': 'bytes' },
        });
      }

      // Formato standard: "bytes=1234-" oppure "bytes=1234-5678".
      const corrispondenza = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!corrispondenza) return new Response('Intestazione Range non valida.', { status: 416 });

      const inizio = corrispondenza[1] ? Number(corrispondenza[1]) : 0;
      const fineRichiesta = corrispondenza[2] ? Number(corrispondenza[2]) : dimensione - 1;
      const fine = Math.min(fineRichiesta, dimensione - 1);
      if (Number.isNaN(inizio) || Number.isNaN(fine) || inizio > fine || inizio >= dimensione) {
        return new Response('Intervallo non disponibile.', {
          status: 416,
          headers: { 'Content-Range': `bytes */${dimensione}` },
        });
      }

      const corpo = Readable.toWeb(createReadStream(percorso, { start: inizio, end: fine })) as ReadableStream<Uint8Array>;
      return new Response(corpo, {
        status: 206,
        headers: {
          'Content-Type': tipo,
          'Content-Length': String(fine - inizio + 1),
          'Content-Range': `bytes ${inizio}-${fine}/${dimensione}`,
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (err) {
      return new Response(err instanceof Error ? err.message : 'File non leggibile.', { status: 404 });
    }
  });
}

export function registraGestionePratiche(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pratiche:importa-cartella', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;

    const cartellaPercorso = result.filePaths[0];
    const cartellaNome = basename(cartellaPercorso);
    const file = await leggiCartellaRicorsiva(cartellaPercorso, cartellaPercorso, win);

    return { cartellaPercorso, cartellaNome, file };
  });

  // Fase 3 (spec §5.3): la pratica resta legata 1:1 alla cartella scelta alla
  // creazione — "Aggiorna dalla cartella" rilegge quella stessa cartella,
  // senza aprire un nuovo selettore, per scoprire i file aggiunti nel
  // frattempo dall'avvocato.
  ipcMain.handle('pratiche:scansiona-cartella', async (_event, percorsoInput: unknown) => {
    const cartellaPercorso = percorsoSchema.parse(percorsoInput);
    const cartellaNome = basename(cartellaPercorso);
    const file = await leggiCartellaRicorsiva(cartellaPercorso, cartellaPercorso, getWindow());
    return { cartellaPercorso, cartellaNome, file };
  });

  // "Cartella non trovata" (spec §5.3): controllo leggero di esistenza per
  // ogni pratica con una cartella collegata, fatto all'avvio e prima di
  // mostrare l'elenco — mai spostare o toccare la cartella dell'avvocato.
  ipcMain.handle('pratiche:verifica-cartelle', async (_event, percorsiInput: unknown) => {
    const percorsi = percorsiSchema.parse(percorsiInput);
    const risultato: Record<string, boolean> = {};
    await Promise.all(
      percorsi.map(async (percorso) => {
        try {
          const stat = await fs.stat(percorso);
          risultato[percorso] = stat.isDirectory();
        } catch {
          risultato[percorso] = false;
        }
      }),
    );
    return risultato;
  });

  ipcMain.handle('pratiche:apri-nella-cartella', (_event, percorsoInput: unknown) => {
    const percorso = percorsoSchema.parse(percorsoInput);
    shell.showItemInFolder(percorso);
  });

  // Ripiego quando il lettore integrato non riesce a riprodurre un file (spec
  // §6.2) — capita con alcuni .m4a/.wma che usano un codec che Chromium non
  // decodifica pur avendo l'estensione giusta. Apre il file con l'app che il
  // sistema operativo associa a quel formato (QuickTime, VLC, Windows Media
  // Player...), quasi sempre più permissiva di un browser.
  ipcMain.handle('pratiche:apri-con-app-predefinita', async (_event, percorsoInput: unknown) => {
    const percorso = percorsoSchema.parse(percorsoInput);
    const erroreOsSeFallito = await shell.openPath(percorso);
    if (erroreOsSeFallito) throw new Error(erroreOsSeFallito);
  });
}
