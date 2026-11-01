import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { estraiTesto, type DocumentoRif, type OnPaginaOcr } from './estrazioneTesto';
import { ESTENSIONI_AUDIO, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';
import type { AvanzamentoTrascrizione } from './trascrizione';

// Indice dei testi della pratica: ogni documento viene letto (PDF, OCR,
// DOCX...) una volta sola, subito dopo l'importazione e in background, e il
// testo estratto resta in cache su disco. Quando Claude chiede un documento
// la risposta è immediata, e una pratica di decine di file si può leggere
// per intero senza aspettare l'OCR a ogni domanda.
//
// La chiave comprende dimensione e data di modifica: un file cambiato
// dall'avvocato viene reindicizzato da solo, uno identico mai due volte.

// Lunghezza di una "parte" restituita da leggi_documento: i documenti più
// lunghi si leggono in più chiamate invece di essere troncati.
export const CARATTERI_PER_PARTE = 60_000;

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

// Testo già indicizzato, senza mai avviare un'estrazione: serve a
// elenca_documenti per dire quante parti ha un documento senza bloccarsi.
export async function testoSeIndicizzato(doc: DocumentoRif & { percorso: string }): Promise<string | null> {
  try {
    return await leggiDallaCache(await chiavePer(doc.percorso));
  } catch {
    return null;
  }
}

// Divide il testo in parti di circa CARATTERI_PER_PARTE, spezzando dove
// possibile fra due paragrafi (o fra due pagine) e non a metà frase.
export function dividiInParti(testo: string): string[] {
  const parti: string[] = [];
  let resto = testo;
  while (resto.length > CARATTERI_PER_PARTE) {
    let taglio = resto.lastIndexOf('\n\n', CARATTERI_PER_PARTE);
    if (taglio < CARATTERI_PER_PARTE / 2) taglio = CARATTERI_PER_PARTE;
    parti.push(resto.slice(0, taglio));
    resto = resto.slice(taglio).replace(/^\n+/, '');
  }
  parti.push(resto);
  return parti;
}

// --- Indicizzazione in background -----------------------------------------

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

export interface Risultato {
  documento: string;
  pagina: number | null;
  estratto: string;
}

// Minuscole e senza accenti: "perche" trova anche "perché". Carattere per
// carattere, così la lunghezza resta identica all'originale e le posizioni
// trovate valgono anche per estrarre il brano dal testo vero.
function normalizza(testo: string): string {
  let risultato = '';
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    risultato += c.length > 0 ? c[0] : ' ';
  }
  return risultato;
}

export function cercaInTesto(nomeDocumento: string, testo: string, cercato: string, massimo: number): Risultato[] {
  const normale = normalizza(testo);
  const ago = normalizza(cercato.trim());
  if (!ago) return [];
  const risultati: Risultato[] = [];
  let da = 0;
  while (risultati.length < massimo) {
    const pos = normale.indexOf(ago, da);
    if (pos === -1) break;
    const pagina = paginaAllaPosizione(testo, pos);
    // Brani corti: con molti risultati sono questi a pesare sul contesto.
    const inizio = Math.max(0, pos - 120);
    const fine = Math.min(testo.length, pos + ago.length + 120);
    risultati.push({
      documento: nomeDocumento,
      pagina,
      estratto: `${inizio > 0 ? '…' : ''}${testo.slice(inizio, fine).replace(/\s+/g, ' ').trim()}${fine < testo.length ? '…' : ''}`,
    });
    da = pos + ago.length;
  }
  return risultati;
}

// --- Pagine, dimensioni e date ---------------------------------------------

// Stima grossolana dei token (italiano: ~3,5 caratteri per token). Serve solo
// a dare a Claude un'idea del peso di ogni documento prima di leggerlo.
export function stimaToken(testo: string): number {
  return Math.ceil(testo.length / 3.5);
}

// Numero dell'ultima pagina marcata "[Pagina N]" nel testo (solo PDF).
export function numeroPagine(testo: string): number | null {
  let massimo = 0;
  for (const m of testo.matchAll(/^\[Pagina (\d+)/gm)) massimo = Math.max(massimo, Number(m[1]));
  return massimo > 0 ? massimo : null;
}

// Solo le pagine da `da` ad `a` (comprese) di un PDF già estratto: una
// verifica puntuale costa poche centinaia di token invece di una parte intera.
export function estraiPagine(testo: string, da: number, a: number): string | null {
  const marcatori = [...testo.matchAll(/^\[Pagina (\d+)/gm)].map((m) => ({ pagina: Number(m[1]), pos: m.index! }));
  const primo = marcatori.find((m) => m.pagina >= da && m.pagina <= a);
  if (!primo) return null;
  // Fine al primo marcatore oltre `a` (le pagine non sono sempre consecutive).
  const successivo = marcatori.find((m) => m.pos > primo.pos && m.pagina > a);
  return testo.slice(primo.pos, successivo?.pos ?? testo.length).trim();
}

function paginaAllaPosizione(testo: string, pos: number): number | null {
  const precedente = testo.lastIndexOf('[Pagina ', pos);
  if (precedente === -1) return null;
  return Number(/^\[Pagina (\d+)/.exec(testo.slice(precedente))?.[1] ?? NaN) || null;
}

const MESI: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

export interface DataTrovata {
  data: string; // AAAA-MM-GG, ordinabile
  documento: string;
  pagina: number | null;
  contesto: string;
}

// Date nel testo, in forma numerica (12/03/2024, 12.03.24, 12-3-2024) o
// estesa ("12 marzo 2024", "1° aprile 2023"), con una riga di contesto: una
// cronologia dei fatti si costruisce da qui senza leggere tutti i documenti.
export function trovaDate(nomeDocumento: string, testo: string): DataTrovata[] {
  const risultati: DataTrovata[] = [];
  const aggiungi = (pos: number, lunghezza: number, g: number, m: number, a: number) => {
    if (a < 100) a += a > 50 ? 1900 : 2000;
    if (m < 1 || m > 12 || g < 1 || a < 1900 || a > 2100) return;
    if (g > new Date(Date.UTC(a, m, 0)).getUTCDate()) return; // 31/02 e simili
    const inizio = Math.max(0, pos - 90);
    const fine = Math.min(testo.length, pos + lunghezza + 90);
    risultati.push({
      data: `${a}-${String(m).padStart(2, '0')}-${String(g).padStart(2, '0')}`,
      documento: nomeDocumento,
      pagina: paginaAllaPosizione(testo, pos),
      contesto: testo.slice(inizio, fine).replace(/\[Pagina[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  };
  for (const m of testo.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    aggiungi(m.index!, m[0].length, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const nomiMesi = Object.keys(MESI).join('|');
  for (const m of testo.matchAll(new RegExp(`\\b(\\d{1,2})(?:°|º)?\\s+(${nomiMesi})\\s+(\\d{4})\\b`, 'gi'))) {
    aggiungi(m.index!, m[0].length, Number(m[1]), MESI[m[2].toLowerCase()], Number(m[3]));
  }
  return risultati;
}
