import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { Database } from '../core/db';
import { elencaDispositivi } from '../core/dispositivi';
import type { Host } from '../core/host';
import { PonteRelay, type IdentitaDesktop, type StatoPonte } from '../core/ponteRelay';
import { casuale, generaCoppia, pubblicaDaPrivata } from '../shared/cifratura';
import { registraErroreGrezzo } from './logger';
import { cifraturaDisponibile, leggiCifrato, scriviCifrato } from './segreti';

// "Sul telefono": l'app JarAI per iPhone/Android si collega a questo
// computer attraverso jarai-relay, cifrato end-to-end (src/core/ponteRelay.ts).
// Qui solo la parte Electron: identità nel portachiavi, conferma nativa,
// QR, IPC per le Impostazioni.
//
// Il ponte parte da solo se c'è almeno un telefono collegato, altrimenti
// alla prima richiesta di QR. Nessun telefono = nessuna connessione al relay.

export const URL_RELAY = process.env.JARAI_RELAY_URL ?? 'wss://jarai-relay.jarai-antonio.workers.dev';
const IDENTITA_PATH = () => join(app.getPath('userData'), 'telefono-identita.bin');

interface IdentitaSalvata {
  hostId: string;
  segreto: string;
  privata: string;
}

export interface StatoTelefono {
  disponibile: boolean;
  stato: StatoPonte;
  dispositivi: Array<{ id: string; nome: string; collegatoIl: string; revocatoIl: string | null }>;
}

async function identita(): Promise<IdentitaDesktop> {
  const salvata = await leggiCifrato(IDENTITA_PATH());
  if (salvata) {
    const i = JSON.parse(salvata) as IdentitaSalvata;
    return { hostId: i.hostId, segreto: i.segreto, privata: i.privata, pubblica: await pubblicaDaPrivata(i.privata) };
  }
  // Prima volta: identità nuova di questo computer.
  const coppia = await generaCoppia();
  const nuova: IdentitaSalvata = { hostId: casuale(18), segreto: casuale(32), privata: coppia.privata };
  await scriviCifrato(IDENTITA_PATH(), JSON.stringify(nuova));
  return { hostId: nuova.hostId, segreto: nuova.segreto, privata: coppia.privata, pubblica: coppia.pubblica };
}

/** Il nome che l'avvocato riconosce ("MacBook di Anna"), non quello di rete. */
function nomeComputer(): string {
  try {
    if (process.platform === 'darwin') {
      const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (n) return n.slice(0, 60);
    }
  } catch {
    // si ripiega sul nome di rete
  }
  if (process.platform === 'win32' && process.env['COMPUTERNAME']) return process.env['COMPUTERNAME'].slice(0, 60);
  return hostname().split('.')[0].slice(0, 60) || 'Computer';
}

export function registraTelefono(db: Database, host: Host, getWindow: () => BrowserWindow | null): void {
  let ponte: PonteRelay | null = null;
  let avvio: Promise<PonteRelay> | null = null;

  const notifica = () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('telefono:cambio');
  };

  const conferma = async (nomeTelefono: string): Promise<boolean> => {
    const win = getWindow();
    const opzioni = {
      type: 'question' as const,
      buttons: ['Collega', 'Rifiuta'],
      defaultId: 1,
      cancelId: 1,
      message: `Collegare "${nomeTelefono}" a JarAI?`,
      detail:
        'Il telefono potrà vedere e usare le conversazioni di questo computer, anche da fuori studio. ' +
        'Collega solo un telefono tuo o dello studio. Puoi scollegarlo quando vuoi dalle Impostazioni.',
    };
    if (win && !win.isDestroyed()) win.show();
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opzioni) : await dialog.showMessageBox(opzioni);
    return response === 0;
  };

  const avvia = (): Promise<PonteRelay> => {
    avvio ??= (async () => {
      ponte = new PonteRelay({
        relay: URL_RELAY,
        identita: await identita(),
        host,
        db,
        nomeComputer: nomeComputer(),
        conferma,
        onStato: notifica,
        onDispositivi: notifica,
        registraErrore: (contesto, dettaglio) => void registraErroreGrezzo(`telefono ${contesto}`, dettaglio),
      });
      ponte.avvia();
      return ponte;
    })();
    avvio.catch(() => {
      avvio = null;
    });
    return avvio;
  };

  const stato = async (): Promise<StatoTelefono> => ({
    disponibile: await cifraturaDisponibile(),
    stato: ponte?.stato ?? 'fermo',
    dispositivi: elencaDispositivi(db).map(({ id, nome, collegatoIl, revocatoIl }) => ({ id, nome, collegatoIl, revocatoIl })),
  });

  ipcMain.handle('telefono:stato', stato);

  ipcMain.handle('telefono:invito', async () => {
    const p = await avvia();
    // Appena avviato: qualche secondo per raggiungere il relay.
    for (let i = 0; i < 50 && p.stato !== 'collegato'; i++) await new Promise((r) => setTimeout(r, 200));
    if (p.stato !== 'collegato') {
      return { ok: false as const, errore: 'Non riesco a raggiungere il servizio JarAI: controlla la connessione a internet.' };
    }
    const { qr, scade } = await p.nuovoInvito();
    // Il QR resta nel processo principale e nella finestra: mai su disco.
    const immagine = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
    return { ok: true as const, immagine, scade };
  });

  ipcMain.handle('telefono:revoca', async (_e, id: string) => {
    if (typeof id !== 'string') return;
    if (ponte) ponte.revoca(id);
    else (await avvia()).revoca(id);
    notifica();
  });

  app.on('before-quit', () => ponte?.ferma());

  // Telefoni già collegati: il ponte parte subito, in silenzio.
  void (async () => {
    if (!(await cifraturaDisponibile())) return;
    if (elencaDispositivi(db).some((d) => !d.revocatoIl)) await avvia();
  })().catch((err) => void registraErroreGrezzo('telefono avvio', err instanceof Error ? err.message : String(err)));
}
