import { app, ipcMain, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from '../core/db';
import type { Host } from '../core/host';
import { ClienteArchivio, fileDaSincronizzare, Sincronizzatore, type StatoSincronizzazione } from '../core/sincronizzazione';
import { registraErroreGrezzo } from './logger';
import { funzioneAttiva, leggiLicenza, statoLicenza } from './licenza';
import { cifraturaDisponibile, leggiCifrato, scriviCifrato } from './segreti';

// "Server privato" (JarAI Server): copia i file delle pratiche sul server
// dello studio (src/core/sincronizzazione.ts). Si attiva dal CRM: funzione
// "server_privato" e indirizzo del server sulla licenza. In sviluppo
// JARAI_SERVER_URL lo attiva senza CRM.

const OGNI = 10 * 60_000;
const CHIAVE_PATH = () => join(app.getPath('userData'), 'server-chiave.bin');

/**
 * La chiave con cui si cifrano i file per il server: nasce qui e resta qui,
 * protetta dal portachiavi del sistema. Se si perde (computer nuovo) se ne
 * crea un'altra e il server viene ricaricato da capo: gli originali sono in
 * studio.
 */
async function chiaveStudio(): Promise<Uint8Array | null> {
  if (!(await cifraturaDisponibile())) return null;
  const salvata = await leggiCifrato(CHIAVE_PATH());
  if (salvata) return Buffer.from(salvata, 'base64');
  const nuova = randomBytes(32);
  await scriviCifrato(CHIAVE_PATH(), nuova.toString('base64'));
  return nuova;
}
const DOPO_MODIFICA = 5_000;

export interface StatoServerPrivato {
  attivo: boolean;
  url: string | null;
  stato: StatoSincronizzazione;
}

export function registraServerPrivato(db: Database, host: Host, getWindow: () => BrowserWindow | null): void {
  let sinc: Sincronizzatore | null = null;
  let url: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let attesa: ReturnType<typeof setTimeout> | null = null;

  const notifica = () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('server:cambio');
  };

  const stato = (): StatoServerPrivato => ({ attivo: !!sinc, url, stato: sinc?.stato ?? { tipo: 'disattivata' } });

  /** Rilegge licenza e funzioni: attiva, cambia o spegne la sincronizzazione. */
  const configura = async (): Promise<void> => {
    const licenza = await leggiLicenza();
    let nuovo: string | null = process.env.JARAI_SERVER_URL ?? null;
    if (!nuovo && licenza && (await funzioneAttiva('server_privato'))) nuovo = (await statoLicenza(licenza)).server?.url ?? null;
    if (!licenza || !nuovo) {
      if (sinc) {
        sinc = null;
        url = null;
        notifica();
      }
      return;
    }
    if (sinc && nuovo === url) return;
    const chiave = await chiaveStudio();
    if (!chiave) {
      void registraErroreGrezzo('server chiave', 'cifratura del sistema non disponibile: sincronizzazione ferma');
      return;
    }
    url = nuovo;
    sinc = new Sincronizzatore({
      cliente: new ClienteArchivio(nuovo, licenza),
      chiave,
      locali: () => fileDaSincronizzare(db),
      onStato: notifica,
      registraErrore: (contesto, dettaglio) => void registraErroreGrezzo(`server ${contesto}`, dettaglio),
    });
    notifica();
    void sinc.sincronizza();
  };

  const giro = async () => {
    await configura();
    if (sinc) await sinc.sincronizza();
  };

  // Documenti aggiunti o tolti: si sincronizza poco dopo (più modifiche di fila = un giro).
  host.abbona((e) => {
    if (e.tipo !== 'entita_cambiata' || (e.payload.entita !== 'documento' && e.payload.entita !== 'pratica') || !sinc) return;
    if (attesa) clearTimeout(attesa);
    attesa = setTimeout(() => void sinc?.sincronizza(), DOPO_MODIFICA);
  });

  ipcMain.handle('server:stato', async () => {
    await configura().catch(() => undefined);
    return stato();
  });
  ipcMain.handle('server:sincronizza', async () => {
    await giro();
    return stato();
  });

  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    if (attesa) clearTimeout(attesa);
  });

  // Si parte qualche secondo dopo l'avvio, per non rallentare la finestra.
  setTimeout(() => {
    void giro().catch((err) => void registraErroreGrezzo('server avvio', err instanceof Error ? err.message : String(err)));
    timer = setInterval(() => void giro().catch(() => undefined), OGNI);
  }, 8_000);
}
