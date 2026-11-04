import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { funzioneAttiva } from '../licenza';
import { ErroreSito, pubblicaArticolo, type EsitoInvio } from './payload';

// Pubblicazione programmata (Studio digitale). L'avvocato approva
// l'articolo e sceglie data e ora: è la sua approvazione, data in anticipo.
// La esegue JarAI: all'ora indicata se è aperto, altrimenti appena viene
// riaperto (lo dice l'interfaccia). Il sito di Molfino ha già la
// pubblicazione programmata di Payload, ma senza un processo che esegua i
// job sul server non partirebbe: quando ci sarà, questa coda potrà
// passare al sito.
//
// Gli esiti restano nel file finché il renderer non li ha ricevuti, così una
// pubblicazione avvenuta all'avvio non va persa.

const FILE = () => join(app.getPath('userData'), 'sito-programmazione.json');
const CONTROLLO_MS = 30_000;
const RIPROVA_MS = 10 * 60_000;
const FUNZIONE = 'studio_digitale';

export interface Programmata {
  conversazioneId: string;
  postId: number | string;
  titolo: string;
  quando: string;
  ultimoTentativo?: string;
  ultimoErrore?: string;
}

export interface EsitoProgrammato {
  conversazioneId: string;
  titolo: string;
  il: string;
  esito?: EsitoInvio;
  errore?: string;
}

interface Archivio {
  coda: Programmata[];
  esiti: EsitoProgrammato[];
}

let timer: NodeJS.Timeout | null = null;
let inCorso = false;

async function leggi(): Promise<Archivio> {
  try {
    const dati = JSON.parse(await fs.readFile(FILE(), 'utf-8')) as Partial<Archivio>;
    return { coda: dati.coda ?? [], esiti: dati.esiti ?? [] };
  } catch {
    return { coda: [], esiti: [] };
  }
}

async function scrivi(archivio: Archivio): Promise<void> {
  await fs.writeFile(FILE(), JSON.stringify(archivio, null, 2));
}

function avvisa(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sito:programmazione-aggiornata');
  }
}

export async function elencoProgrammate(): Promise<Programmata[]> {
  return (await leggi()).coda;
}

export async function programma(voce: Omit<Programmata, 'ultimoTentativo' | 'ultimoErrore'>): Promise<Programmata[]> {
  if (Number.isNaN(Date.parse(voce.quando))) throw new ErroreSito('Data di pubblicazione non valida.');
  if (Date.parse(voce.quando) < Date.now() - 60_000) throw new ErroreSito('La data di pubblicazione è già passata.');
  const archivio = await leggi();
  archivio.coda = [...archivio.coda.filter((p) => p.conversazioneId !== voce.conversazioneId), voce];
  await scrivi(archivio);
  return archivio.coda;
}

export async function annullaProgrammazione(conversazioneId: string): Promise<Programmata[]> {
  const archivio = await leggi();
  archivio.coda = archivio.coda.filter((p) => p.conversazioneId !== conversazioneId);
  await scrivi(archivio);
  return archivio.coda;
}

// Il renderer ritira gli esiti e li applica alle sue conversazioni.
export async function ritiraEsiti(): Promise<EsitoProgrammato[]> {
  const archivio = await leggi();
  if (!archivio.esiti.length) return [];
  const esiti = archivio.esiti;
  archivio.esiti = [];
  await scrivi(archivio);
  return esiti;
}

async function controlla(): Promise<void> {
  if (inCorso) return;
  inCorso = true;
  try {
    const archivio = await leggi();
    const ora = Date.now();
    const scadute = archivio.coda.filter(
      (p) =>
        Date.parse(p.quando) <= ora &&
        (!p.ultimoTentativo || ora - Date.parse(p.ultimoTentativo) >= RIPROVA_MS),
    );
    if (!scadute.length) return;
    if (!(await funzioneAttiva(FUNZIONE))) return;
    let cambiato = false;
    for (const voce of scadute) {
      try {
        const esito = await pubblicaArticolo(voce.postId);
        archivio.coda = archivio.coda.filter((p) => p.conversazioneId !== voce.conversazioneId);
        archivio.esiti.push({ conversazioneId: voce.conversazioneId, titolo: voce.titolo, il: new Date().toISOString(), esito });
      } catch (err) {
        // Si riprova tra dieci minuti; l'errore resta visibile nel calendario.
        voce.ultimoTentativo = new Date().toISOString();
        voce.ultimoErrore = err instanceof ErroreSito ? err.message : 'Pubblicazione non riuscita. Riprovo tra poco.';
      }
      cambiato = true;
    }
    if (cambiato) {
      await scrivi(archivio);
      avvisa();
    }
  } finally {
    inCorso = false;
  }
}

export function avviaProgrammazione(): void {
  if (timer) return;
  // Primo controllo poco dopo l'avvio: recupera quelle scadute ad app chiusa.
  setTimeout(() => void controlla(), 8_000);
  timer = setInterval(() => void controlla(), CONTROLLO_MS);
}
