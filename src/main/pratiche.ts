import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { extname, basename, dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { CARTELLA_PRINCIPALE, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';
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
}
