import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { estraiTesto, type DocumentoRif, type OnPaginaOcr } from './estrazioneTesto';
import { ESTENSIONI_AUDIO, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';
import type { AvanzamentoTrascrizione } from './trascrizione';

// Le funzioni pure sul testo stanno in src/core/testi.ts (servono anche al server).
export { CARATTERI_PER_PARTE, dividiInParti, cercaInTesto, stimaToken, numeroPagine, estraiPagine, trovaDate, type Risultato, type DataTrovata } from '../core/testi';

// Indice dei testi della pratica: ogni documento viene letto (PDF, OCR,
// DOCX...) una volta sola, subito dopo l'importazione e in background, e il
// testo estratto resta in cache su disco. Quando Claude chiede un documento
// la risposta è immediata, e una pratica di decine di file si può leggere
// per intero senza aspettare l'OCR a ogni domanda.
//
// La chiave comprende dimensione e data di modifica: un file cambiato
// dall'avvocato viene reindicizzato da solo, uno identico mai due volte.


const CARTELLA_INDICE = () => join(app.getPath('userData'), 'indice-testi');

interface VoceIndice {
  testo: string;
  indicizzatoIl: string;
}

interface Ascoltatori {
  onAvanzamento: Set<(a: AvanzamentoTrascrizione) => void>;
  onPaginaOcr: Set<OnPaginaOcr>;
}

const inCorso = new Map<string, { promessa: Promise<string>; ascoltatori: Ascoltatori }>();
// Testi già letti in questa sessione: la ricerca li scorre tutti a ogni
// chiamata, rileggerli dal disco ogni volta sarebbe inutile.
const inMemoria = new Map<string, string>();

function estensione(doc: DocumentoRif): string {
  return extname(doc.nome).slice(1).toLowerCase();
}

export function indicizzabile(doc: DocumentoRif): doc is DocumentoRif & { percorso: string } {
  return Boolean(doc.percorso) && ESTENSIONI_LEGGIBILI.has(estensione(doc));
}

async function chiavePer(percorso: string): Promise<string> {
  const stat = await fs.stat(percorso);
  return createHash('sha1').update(`${percorso}|${stat.size}|${stat.mtimeMs}`).digest('hex');
}

async function leggiDallaCache(chiave: string): Promise<string | null> {
  const inRam = inMemoria.get(chiave);
  if (inRam !== undefined) return inRam;
  try {
    const voce = JSON.parse(await fs.readFile(join(CARTELLA_INDICE(), `${chiave}.json`), 'utf-8')) as VoceIndice;
    inMemoria.set(chiave, voce.testo);
    return voce.testo;
  } catch {
    return null;
  }
}

async function scriviNellaCache(chiave: string, testo: string): Promise<void> {
  inMemoria.set(chiave, testo);
  const voce: VoceIndice = { testo, indicizzatoIl: new Date().toISOString() };
  await fs.mkdir(CARTELLA_INDICE(), { recursive: true });
  await fs.writeFile(join(CARTELLA_INDICE(), `${chiave}.json`), JSON.stringify(voce), 'utf-8');
}

// Testo completo di un documento: dalla cache se c'è, altrimenti lo estrae
// adesso. Se lo sta già estraendo l'indice in background, si aggancia allo
// stesso lavoro (e al suo avanzamento) invece di ripartire da zero.
export async function testoDocumento(
  doc: DocumentoRif & { percorso: string },
  onAvanzamento?: (a: AvanzamentoTrascrizione) => void,
  onPaginaOcr?: OnPaginaOcr,
): Promise<string> {
  const chiave = await chiavePer(doc.percorso);
  const inCache = await leggiDallaCache(chiave);
  if (inCache !== null) return inCache;

  let lavoro = inCorso.get(chiave);
  if (!lavoro) {
    const ascoltatori: Ascoltatori = { onAvanzamento: new Set(), onPaginaOcr: new Set() };
    const promessa = estraiTesto(
      doc,
      (a) => ascoltatori.onAvanzamento.forEach((f) => f(a)),
      (pagina, totale) => ascoltatori.onPaginaOcr.forEach((f) => f(pagina, totale)),
    )
      .then(async (testo) => {
        await scriviNellaCache(chiave, testo).catch(() => undefined);
        return testo;
      })
      .finally(() => inCorso.delete(chiave));
    lavoro = { promessa, ascoltatori };
    inCorso.set(chiave, lavoro);
  }
  if (onAvanzamento) lavoro.ascoltatori.onAvanzamento.add(onAvanzamento);
  if (onPaginaOcr) lavoro.ascoltatori.onPaginaOcr.add(onPaginaOcr);
  try {
    return await lavoro.promessa;
  } finally {
    if (onAvanzamento) lavoro.ascoltatori.onAvanzamento.delete(onAvanzamento);
    if (onPaginaOcr) lavoro.ascoltatori.onPaginaOcr.delete(onPaginaOcr);
  }
}

/** Il file dell'indice con il testo di un documento, se già estratto (per il server privato). */
export async function percorsoTestoIndicizzato(percorso: string): Promise<string | null> {
  try {
    const file = join(CARTELLA_INDICE(), `${await chiavePer(percorso)}.json`);
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

// Testo già indicizzato, senza mai avviare un'estrazione: serve a
// elenca_documenti per dire quante parti ha un documento senza bloccarsi.
export async function testoSeIndicizzato(doc: DocumentoRif & { percorso: string }): Promise<string | null> {
  try {
    return await leggiDallaCache(await chiavePer(doc.percorso));
  } catch {
    return null;
  }
}

export interface StatoIndicizzazione {
  totale: number;
  completati: number;
  corrente: string | null;
}

const coda: (DocumentoRif & { percorso: string })[] = [];
const inCodaOFatti = new Set<string>();
let stato: StatoIndicizzazione = { totale: 0, completati: 0, corrente: null };
let attiva = false;

function pubblicaStato(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('indice:evento', stato);
  }
}

// Mette in coda tutti i documenti leggibili non ancora indicizzati. L'audio
// resta escluso: la trascrizione richiede il componente vocale installato e
// minuti per ogni registrazione, quindi parte solo quando serve davvero
// (da Claude o dal pulsante "Trascrivi"), come prima.
export function indicizzaInBackground(documenti: DocumentoRif[]): void {
  for (const doc of documenti) {
    if (!indicizzabile(doc) || ESTENSIONI_AUDIO.has(estensione(doc))) continue;
    if (inCodaOFatti.has(doc.percorso)) continue;
    inCodaOFatti.add(doc.percorso);
    coda.push(doc);
    stato = { ...stato, totale: stato.totale + 1 };
  }
  if (!attiva && coda.length > 0) void svuotaCoda();
}

async function svuotaCoda(): Promise<void> {
  attiva = true;
  pubblicaStato();
  while (coda.length > 0) {
    const doc = coda.shift()!;
    stato = { ...stato, corrente: doc.nome };
    pubblicaStato();
    try {
      await testoDocumento(doc);
    } catch {
      // Documento illeggibile (corrotto, protetto...): l'errore vero lo
      // vedrà Claude quando prova a leggerlo; qui si passa al successivo.
      // Tolto dai "fatti" così un nuovo tentativo resta possibile.
      inCodaOFatti.delete(doc.percorso);
    }
    stato = { ...stato, completati: stato.completati + 1 };
  }
  stato = { totale: 0, completati: 0, corrente: null };
  attiva = false;
  pubblicaStato();
}

// --- Ricerca nel testo -----------------------------------------------------

