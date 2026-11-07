import { app, BrowserWindow, ipcMain, session, type Session } from 'electron';
import { leggiCifrato, scriviCifrato } from './segreti';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import {
  ClienteDejure,
  CONSULTAZIONI_MAX_PER_DOMANDA,
  creaServerDejure as creaServerDejureComune,
  ErroreDejure,
  PROMPT_DEJURE,
  STRUMENTI_DEJURE,
  type CategoriaDejure,
  type CredenzialiDejure,
  type DocumentoDejure,
  type PaginaWeb,
  type RicercaDejure,
} from '../core/dejure';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Integrazione DeJure (Lefebvre Giuffrè). DeJure non offre un'API: JarAI
// apre il sito in una finestra nascosta, con le credenziali dell'avvocato,
// e ne legge le pagine di ricerca e di dettaglio come farebbe lui (la logica
// è in src/core/dejure.ts, comune al server privato).
//
// È un'integrazione che l'avvocato attiva da sé, accettando un'avvertenza
// esplicita (Impostazioni → Integrazioni): la licenza d'uso DeJure (art. 4.4)
// limita l'uso dei dati a esigenze professionali proprie, e l'accesso
// automatizzato resta sotto la sua responsabilità. Per questo:
//  - le credenziali sono sue, cifrate con safeStorage come la chiave dello
//    studio (claudeAuth.ts), mai in chiaro e mai nella cartella della pratica;
//  - la sessione DeJure vive in una partizione separata (persist:dejure),
//    lontana da quella dell'app (CSP, cookie);
//  - una richiesta alla volta e un tetto di consultazioni per domanda: ricerche
//    puntuali, mai scaricamenti in blocco.

const PARTIZIONE = 'persist:dejure';
const CREDENZIALI_PATH = () => join(app.getPath('userData'), 'dejure-credenziali.enc');
const STATO_PATH = () => join(app.getPath('userData'), 'dejure.json');

type Credenziali = CredenzialiDejure;

interface StatoSalvato {
  utente: string;
  avvertenzaAccettataIl: string;
  collegatoIl: string;
}

export interface StatoDejure {
  attiva: boolean;
  utente?: string;
  avvertenzaAccettataIl?: string;
}

// ─── Credenziali e stato ────────────────────────────────────────────────

async function salvaCredenziali(cred: Credenziali): Promise<void> {
  await scriviCifrato(CREDENZIALI_PATH(), JSON.stringify(cred));
}

async function leggiCredenziali(): Promise<Credenziali | null> {
  const testo = await leggiCifrato(CREDENZIALI_PATH());
  try {
    return testo ? (JSON.parse(testo) as Credenziali) : null;
  } catch {
    return null;
  }
}

async function leggiStatoSalvato(): Promise<StatoSalvato | null> {
  try {
    return JSON.parse(await fs.readFile(STATO_PATH(), 'utf-8')) as StatoSalvato;
  } catch {
    return null;
  }
}

/** Per l'assistente di riserva sul server privato: credenziali solo se DeJure è collegato. */
export async function credenzialiDejurePerServer(): Promise<Credenziali | null> {
  return (await dejureAttiva()) ? leggiCredenziali() : null;
}

export async function statoDejure(): Promise<StatoDejure> {
  const [stato, cred] = await Promise.all([leggiStatoSalvato(), leggiCredenziali()]);
  if (!stato || !cred) return { attiva: false };
  return { attiva: true, utente: stato.utente, avvertenzaAccettataIl: stato.avvertenzaAccettataIl };
}

export async function dejureAttiva(): Promise<boolean> {
  return (await statoDejure()).attiva;
}

// ─── Finestra nascosta ──────────────────────────────────────────────────

let finestra: BrowserWindow | null = null;

function sessioneDejure(): Session {
  const ses = session.fromPartition(PARTIZIONE);
  // Lo user agent di Electron contiene "Electron/x.y": alcuni siti lo
  // trattano come un client sconosciuto. Si presenta come il Chrome che è.
  ses.setUserAgent(ses.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*jarai\/\S+/i, ''));
  return ses;
}

function apriFinestra(): BrowserWindow {
  if (finestra && !finestra.isDestroyed()) return finestra;
  finestra = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: sessioneDejure(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Nessun throttling: la finestra non è mai visibile, ma le pagine
      // devono comunque caricare e disegnare i risultati.
      backgroundThrottling: false,
    },
  });
  finestra.webContents.setAudioMuted(true);
  finestra.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  finestra.on('closed', () => {
    finestra = null;
  });
  return finestra;
}

function chiudiFinestra(): void {
  if (finestra && !finestra.isDestroyed()) finestra.destroy();
  finestra = null;
}

function paginaFinestra(win: BrowserWindow): PaginaWeb {
  return {
    carica: async (url) => {
      try {
        await win.loadURL(url);
      } catch (err) {
        // Le SPA annullano spesso il primo caricamento con un redirect interno
        // (ERR_ABORTED): la pagina arriva comunque, il resto lo verifica chi chiama.
        if (!/ERR_ABORTED/.test(String(err))) throw err;
      }
    },
    valuta: async <T>(codice: string) => (await win.webContents.executeJavaScript(codice, true)) as T,
    frame: () =>
      win.webContents.mainFrame.framesInSubtree.map((f) => ({
        valuta: async <T>(codice: string) => (await f.executeJavaScript(codice)) as T,
      })),
  };
}

const cliente = new ClienteDejure({
  pagina: async () => paginaFinestra(apriFinestra()),
  credenziali: leggiCredenziali,
});

export const cercaDejure = (testo: string, massimo: number, categoria?: CategoriaDejure): Promise<RicercaDejure> =>
  cliente.cerca(testo, massimo, categoria);
export const leggiDejure = (id: string, testoIntegrale: boolean): Promise<DocumentoDejure> => cliente.leggi(id, testoIntegrale);

// ─── Collegamento da Impostazioni ───────────────────────────────────────

async function collega(cred: Credenziali): Promise<StatoDejure> {
  // Si parte da una sessione pulita: un login vecchio di un altro utente non
  // deve far sembrare valide credenziali nuove sbagliate.
  await scollegaSessione();
  await cliente.accedi(cred);
  await salvaCredenziali(cred);
  const ora = new Date().toISOString();
  const stato: StatoSalvato = { utente: cred.utente, avvertenzaAccettataIl: ora, collegatoIl: ora };
  await fs.writeFile(STATO_PATH(), JSON.stringify(stato), 'utf-8');
  return statoDejure();
}

async function scollegaSessione(): Promise<void> {
  chiudiFinestra();
  await session.fromPartition(PARTIZIONE).clearStorageData();
}

async function scollega(): Promise<void> {
  await scollegaSessione();
  await fs.unlink(CREDENZIALI_PATH()).catch(() => undefined);
  await fs.unlink(STATO_PATH()).catch(() => undefined);
}

const collegaSchema = z.object({
  utente: z.string().trim().min(3),
  password: z.string().min(1),
  avvertenzaAccettata: z.literal(true),
});

export function registraDejure(): void {
  ipcMain.handle('dejure:stato', async () => statoDejure());

  ipcMain.handle('dejure:collega', async (_event, input: unknown) => {
    const { utente, password } = collegaSchema.parse(input);
    try {
      return { ok: true as const, stato: await collega({ utente, password }) };
    } catch (err) {
      await scollegaSessione().catch(() => undefined);
      return { ok: false as const, errore: err instanceof ErroreDejure ? err.message : 'Collegamento a DeJure non riuscito. Riprova.' };
    }
  });

  ipcMain.handle('dejure:scollega', async () => scollega());
}

// ─── Strumenti per Claude ───────────────────────────────────────────────

export const creaServerDejure = (): McpSdkServerConfigWithInstance => creaServerDejureComune(cliente);
export { CONSULTAZIONI_MAX_PER_DOMANDA, PROMPT_DEJURE, STRUMENTI_DEJURE };
