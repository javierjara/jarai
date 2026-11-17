import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import MsgReader from '@kenjiuno/msgreader';
import PostalMime, { type Address } from 'postal-mime';
import forge from 'node-forge';
import Tesseract from 'tesseract.js';
import { CARTELLA_ZIP_ESTRATTI } from './zip';
import { trascriviAudio, type AvanzamentoTrascrizione } from './trascrizione';
import { CARTELLA_PRINCIPALE, ESTENSIONI_AUDIO, ESTENSIONI_IMMAGINE, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';

// Estrazione del testo dai documenti della pratica: condivisa fra l'indice
// in background (indice.ts) e gli strumenti di Claude (documentTools.ts).
export interface DocumentoRif {
  nome: string;
  percorso?: string;
  cartella: string;
  tipo: string;
  pagine?: number;
}

export type OnPaginaOcr = (pagina: number, totale: number) => void;

// Sotto questa soglia una pagina PDF si considera scansionata (a volte resta
// solo un timbro o un numero di pagina come testo vero).
const MIN_CARATTERI_PAGINA = 20;
// Con l'indice in background (indice.ts) l'OCR non blocca più la risposta:
// il tetto resta solo come protezione da fascicoli enormi.
const MAX_PAGINE_OCR = 1000;
// Pagine rasterizzate per volta: tutte insieme, centinaia di immagini a
// scala 2 starebbero in memoria contemporaneamente.
const PAGINE_PER_BLOCCO_OCR = 10;

// Tesseract scarica i modelli lingua al primo uso (rete richiesta una sola
// volta, poi restano in cache qui) — senza `cachePath` esplicito scrive nella
// cartella di lavoro del processo, imprevedibile e non scrivibile una volta
// impacchettata l'app.
const CARTELLA_CACHE_OCR = () => join(app.getPath('userData'), 'ocr-cache');

async function ocrImmagine(buffer: Buffer): Promise<string> {
  await fs.mkdir(CARTELLA_CACHE_OCR(), { recursive: true });
  const { data } = await Tesseract.recognize(buffer, 'ita+eng', { cachePath: CARTELLA_CACHE_OCR() });
  return data.text.trim();
}

// Estrae il contenuto testuale grezzo (bytes) di un file .p7m: una busta
// crittografica CMS/PKCS#7 SignedData che avvolge il documento originale.
// L'OCTET STRING del contenuto può arrivare frammentato in più blocchi
// (BER constructed encoding) per i file più grandi — vanno riuniti in ordine.
function estraiContenutoFirmato(buffer: Buffer): Buffer {
  const der = forge.util.createBuffer(buffer.toString('binary'));
  const asn1 = forge.asn1.fromDer(der);
  const messaggio = forge.pkcs7.messageFromAsn1(asn1) as unknown as {
    rawCapture?: { content?: forge.asn1.Asn1 };
  };
  const contenuto = messaggio.rawCapture?.content;
  if (!contenuto) {
    throw new Error('Busta P7M senza contenuto firmato riconoscibile (forse una firma "detached").');
  }
  const raccogli = (nodo: forge.asn1.Asn1): string =>
    nodo.composed ? (nodo.value as forge.asn1.Asn1[]).map(raccogli).join('') : (nodo.value as string);
  return Buffer.from(raccogli(contenuto), 'binary');
}

// Spoglio minimo di un RTF: rimuove i gruppi di controllo, i control word e
// le graffe, converte gli escape esadecimali (\'e0 ecc.). Non è un parser
// RTF completo, ma basta a recuperare il testo visibile per un modello.
function rtfATesto(buffer: Buffer): string {
  return buffer
    .toString('latin1')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Email (.eml, .msg) ------------------------------------------------------
//
// Un .eml è un messaggio MIME: il corpo e gli allegati (foto, PDF, PEC
// inoltrate) stanno codificati in base64 nello stesso file. Letto come testo
// semplice diventava decine di migliaia di righe illeggibili che superavano il
// limite di ogni lettura. Qui si estraggono intestazioni e corpo, e ogni
// allegato passa dallo stesso estrattore degli altri documenti (OCR per le
// foto, pdf-parse per i PDF, busta .p7m, email annidate come la postacert.eml
// delle PEC).

// Email dentro email (inoltri di inoltri, PEC): oltre questa profondità gli
// allegati annidati vengono solo elencati.
const MAX_PROFONDITA_EMAIL = 4;
// Immagini incorporate nel corpo HTML (loghi, firme, icone social): sotto
// questa dimensione non vale la pena di farne l'OCR. Le foto vere pesano
// molto di più.
const MIN_BYTE_IMMAGINE_INCORPORATA = 30_000;

const ESTENSIONE_DA_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/plain': 'txt',
  'message/rfc822': 'eml',
  'application/vnd.ms-outlook': 'msg',
  'application/pkcs7-mime': 'p7m',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Firme S/MIME del messaggio stesso (smime.p7s): niente da leggere.
const MIME_FIRMA = new Set(['application/pkcs7-signature', 'application/x-pkcs7-signature']);

function htmlATesto(html: string): string {
  return html
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formattaIndirizzi(indirizzi: Address[] | Address | undefined): string {
  const lista = Array.isArray(indirizzi) ? indirizzi : indirizzi ? [indirizzi] : [];
  return lista
    .flatMap((a) => ('group' in a && a.group ? a.group : [a]))
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name))
    .filter(Boolean)
    .join(', ');
}

function formattaData(data: string | undefined): string | null {
  if (!data) return null;
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return data;
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
}

interface AllegatoEmail {
  nome: string;
  contenuto: Buffer;
  mime?: string;
  incorporato?: boolean;
}

// Testo di un allegato, con le pagine dei PDF rinominate in "[pag. N]": i
// marcatori "[Pagina N]" sono riservati ai PDF letti direttamente, altrimenti
// un'email con due PDF allegati sembrerebbe un documento a pagine con i
// numeri ripetuti.
function estensioneAllegato(a: AllegatoEmail): string {
  const ext = extname(a.nome).slice(1).toLowerCase();
  if (ESTENSIONI_LEGGIBILI.has(ext) && !ESTENSIONI_AUDIO.has(ext)) return ext;
  return ESTENSIONE_DA_MIME[a.mime ?? ''] ?? ext;
}

async function testoAllegati(allegati: AllegatoEmail[], profondita: number, onPaginaOcr?: OnPaginaOcr): Promise<string[]> {
  const sezioni: string[] = [];
  const totale = allegati.length;
  for (const [i, a] of allegati.entries()) {
    const ext = estensioneAllegato(a);
    const titolo = `[Allegato ${i + 1} di ${totale}: ${a.nome}`;
    let testo: string;
    if (!ESTENSIONI_LEGGIBILI.has(ext) || ESTENSIONI_AUDIO.has(ext)) {
      testo = '(formato non leggibile automaticamente)';
    } else if ((ext === 'eml' || ext === 'msg') && profondita >= MAX_PROFONDITA_EMAIL) {
      testo = '(email annidata troppo in profondità: non letta)';
    } else {
      try {
        testo = (await estraiTestoDaBuffer(a.contenuto, ext, a.nome, onPaginaOcr, profondita + 1)).replace(/^\[Pagina (\d+)/gm, '[pag. $1');
      } catch (err) {
        testo = `(allegato non leggibile: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    const tipo = ESTENSIONI_IMMAGINE.has(ext) ? ' — immagine, qui solo il testo da OCR' : ext === 'eml' || ext === 'msg' ? ' — email allegata' : '';
    sezioni.push(`${titolo}${tipo}]\n${testo.trim() || '(vuoto)'}`);
  }
  return sezioni;
}

function componiEmail(intestazione: (string | null)[], corpo: string, sezioniAllegati: string[]): string {
  return [
    intestazione.filter(Boolean).join('\n'),
    `[Testo dell'email]\n${corpo.trim() || '(nessun testo nel corpo dell\'email)'}`,
    ...sezioniAllegati,
  ].join('\n\n');
}

async function apriEml(buffer: Buffer) {
  // forceRfc822Attachments: le email inoltrate come allegato (e la
  // postacert.eml delle PEC) restano allegati distinti, letti a loro volta,
  // invece di essere fuse nel corpo del messaggio esterno.
  const email = await PostalMime.parse(buffer, { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' });
  const allegati: AllegatoEmail[] = [];
  const saltati: string[] = [];
  for (const a of email.attachments) {
    const contenuto = Buffer.from(a.content as ArrayBuffer);
    const nome = a.filename || `allegato senza nome (${a.mimeType})`;
    if (MIME_FIRMA.has(a.mimeType.toLowerCase()) || /^smime\.p7s$/i.test(nome)) continue;
    const incorporato = Boolean(a.related) || (a.disposition === 'inline' && !a.filename);
    if (incorporato && a.mimeType.startsWith('image/') && contenuto.length < MIN_BYTE_IMMAGINE_INCORPORATA) {
      saltati.push(nome);
      continue;
    }
    allegati.push({ nome, contenuto, mime: a.mimeType.toLowerCase(), incorporato });
  }
  return { email, allegati, saltati };
}

async function emlATesto(buffer: Buffer, profondita: number, onPaginaOcr?: OnPaginaOcr): Promise<string> {
  const { email, allegati, saltati } = await apriEml(buffer);
  const corpo = email.text?.trim() ? email.text : email.html ? htmlATesto(email.html) : '';
  const intestazione = [
    email.from ? `Da: ${formattaIndirizzi(email.from)}` : null,
    email.to?.length ? `A: ${formattaIndirizzi(email.to)}` : null,
    email.cc?.length ? `Cc: ${formattaIndirizzi(email.cc)}` : null,
    formattaData(email.date) ? `Data: ${formattaData(email.date)}` : null,
    email.subject ? `Oggetto: ${email.subject}` : null,
    allegati.length ? `Allegati (${allegati.length}): ${allegati.map((a) => a.nome).join(', ')}` : null,
    saltati.length ? `(${saltati.length} immagini incorporate piccole — loghi o firme — non lette)` : null,
  ];
  return componiEmail(intestazione, corpo, await testoAllegati(allegati, profondita, onPaginaOcr));
}

function apriMsg(buffer: Buffer) {
  const lettore = new MsgReader(buffer);
  const dati = lettore.getFileData();
  const allegati: AllegatoEmail[] = [];
  for (const a of dati.attachments ?? []) {
    try {
      const estratto = lettore.getAttachment(a);
      const nome = estratto.fileName || a.fileName || a.name || 'allegato senza nome';
      const contenuto = Buffer.from(estratto.content);
      if (/^smime\.p7s$/i.test(nome)) continue;
      if (a.attachmentHidden && (a.attachMimeTag ?? '').startsWith('image/') && contenuto.length < MIN_BYTE_IMMAGINE_INCORPORATA) continue;
      allegati.push({ nome: a.innerMsgContent && !/\.msg$/i.test(nome) ? `${nome}.msg` : nome, contenuto, mime: a.attachMimeTag?.toLowerCase() });
    } catch {
      allegati.push({ nome: a.fileName || a.name || 'allegato senza nome', contenuto: Buffer.alloc(0) });
    }
  }
  return { dati, allegati };
}

async function msgATesto(buffer: Buffer, profondita: number, onPaginaOcr?: OnPaginaOcr): Promise<string> {
  const { dati, allegati } = apriMsg(buffer);
  const destinatari = (dati.recipients ?? []).map((r) => (r.name && r.smtpAddress ? `${r.name} <${r.smtpAddress}>` : r.smtpAddress || r.email || r.name));
  const corpo = dati.body?.trim() ? dati.body : dati.bodyHtml ? htmlATesto(dati.bodyHtml) : '';
  const intestazione = [
    dati.senderName || dati.senderEmail ? `Da: ${[dati.senderName, dati.senderSmtpAddress || dati.senderEmail ? `<${dati.senderSmtpAddress || dati.senderEmail}>` : null].filter(Boolean).join(' ')}` : null,
    destinatari.length ? `A: ${destinatari.filter(Boolean).join(', ')}` : null,
    formattaData(dati.clientSubmitTime || dati.messageDeliveryTime) ? `Data: ${formattaData(dati.clientSubmitTime || dati.messageDeliveryTime)}` : null,
    dati.subject ? `Oggetto: ${dati.subject}` : null,
    allegati.length ? `Allegati (${allegati.length}): ${allegati.map((a) => a.nome).join(', ')}` : null,
  ];
  return componiEmail(intestazione, corpo, await testoAllegati(allegati, profondita, onPaginaOcr));
}

async function estraiTestoDaBuffer(
  buffer: Buffer,
  estensione: string,
  nomeFile: string,
  onPaginaOcr?: OnPaginaOcr,
  profondita = 0,
): Promise<string> {
  const ext = estensione.toLowerCase();

  if (ext === 'pdf') {
    // Import dinamico, non in cima al file: pdf-parse si appoggia a un
    // pacchetto nativo (@napi-rs/canvas) per un polyfill di API del browser
    // (DOMMatrix) di cui non ha davvero bisogno per il solo testo — se quel
    // pacchetto nativo manca o non è compatibile con questo computer (per
    // esempio dopo un pacchettizzazione incrociata da un altro sistema
    // operativo), l'errore va a finire nel try/catch di leggi_documento
    // (solo questo documento non si legge) invece di far fallire l'avvio di
    // tutta l'app, come succedeva quando l'import era statico in cima al file.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const risultato = await parser.getText();
      // Pagine scansionate (nessun layer di testo): le rasterizziamo e le
      // passiamo a Tesseract, a blocchi per contenere la memoria.
      const daOcr = risultato.pages
        .filter((p) => p.text.trim().length < MIN_CARATTERI_PAGINA)
        .map((p) => p.num)
        .slice(0, MAX_PAGINE_OCR);
      const testoOcr = new Map<number, string>();
      for (let inizio = 0; inizio < daOcr.length; inizio += PAGINE_PER_BLOCCO_OCR) {
        const blocco = daOcr.slice(inizio, inizio + PAGINE_PER_BLOCCO_OCR);
        const schermate = await parser.getScreenshot({ partial: blocco, scale: 2, imageBuffer: true, imageDataUrl: false });
        for (const s of schermate.pages) {
          onPaginaOcr?.(testoOcr.size + 1, daOcr.length);
          testoOcr.set(s.pageNumber, await ocrImmagine(Buffer.from(s.data)));
        }
      }
      const pagineScansionate = risultato.pages.filter((p) => p.text.trim().length < MIN_CARATTERI_PAGINA).length;
      const testo = risultato.pages
        .map((p) => {
          const ocr = testoOcr.get(p.num);
          return ocr !== undefined ? `[Pagina ${p.num} — testo da OCR]\n${ocr}` : `[Pagina ${p.num}]\n${p.text}`;
        })
        .join('\n\n');
      const avviso =
        pagineScansionate > daOcr.length
          ? `\n\n(OCR eseguito solo sulle prime ${MAX_PAGINE_OCR} pagine scansionate su ${pagineScansionate}.)`
          : '';
      if (testo.replace(/\[Pagina[^\]]*\]/g, '').trim().length === 0) {
        return '(Questo PDF sembra una scansione, ma l\'OCR non ha riconosciuto testo leggibile.)';
      }
      return testo + avviso;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === 'docx') {
    const risultato = await mammoth.extractRawText({ buffer });
    return risultato.value;
  }
  if (ext === 'doc') {
    const documento = await new WordExtractor().extract(buffer);
    return documento.getBody();
  }
  if (ext === 'rtf') {
    return rtfATesto(buffer);
  }
  if (ext === 'txt') {
    return buffer.toString('utf-8');
  }
  if (ext === 'eml') {
    return emlATesto(buffer, profondita, onPaginaOcr);
  }
  if (ext === 'msg') {
    return msgATesto(buffer, profondita, onPaginaOcr);
  }
  if (ESTENSIONI_IMMAGINE.has(ext)) {
    const testo = await ocrImmagine(buffer);
    return testo || '(Nessun testo riconosciuto in questa immagine.)';
  }
  if (ext === 'p7m') {
    const estratto = estraiContenutoFirmato(buffer);
    // Convenzione italiana: "Decreto ingiuntivo.pdf.p7m" — l'estensione prima
    // di .p7m dice come interpretare il contenuto firmato appena estratto.
    const nomeInterno = nomeFile.replace(/\.p7m$/i, '');
    let estensioneInterna = extname(nomeInterno).slice(1).toLowerCase();
    // Email firmata S/MIME (smime.p7m dentro un .eml): il contenuto è a sua
    // volta un messaggio MIME, senza estensione nel nome.
    if (!ESTENSIONI_LEGGIBILI.has(estensioneInterna) && /^(?:[\w-]+:[^\r\n]*\r?\n)*content-type:/i.test(estratto.subarray(0, 4000).toString('latin1'))) {
      estensioneInterna = 'eml';
    }
    if (!estensioneInterna || !ESTENSIONI_LEGGIBILI.has(estensioneInterna) || estensioneInterna === 'p7m') {
      return '(Contenuto firmato estratto correttamente, ma il formato del documento originale non è tra quelli leggibili automaticamente.)';
    }
    return estraiTestoDaBuffer(estratto, estensioneInterna, nomeInterno, onPaginaOcr, profondita);
  }
  throw new Error(`Il formato ${ext.toUpperCase()} non è ancora leggibile automaticamente.`);
}

// Risale dal percorso di un documento alla cartella radice della pratica,
// usando l'etichetta `cartella` già calcolata dallo scanner (pratiche.ts):
// "Atti" per un file annidato una cartella sotto la radice, "Cartella
// principale" per un file già alla radice. Serve solo per sapere dove creare
// "JarAI - Bozze" quando si salva una trascrizione — mai per leggere o
// scrivere altrove.
function radicePratica(doc: DocumentoRif): string | null {
  // Un audio estratto da uno zip vive nella cartella dati di JarAI: non c'è
  // una cartella della pratica accanto in cui salvare la trascrizione.
  if (!doc.percorso || doc.percorso.startsWith(CARTELLA_ZIP_ESTRATTI())) return null;
  if (doc.cartella === CARTELLA_PRINCIPALE) return dirname(doc.percorso);
  const livelli = doc.cartella.split('/').length;
  let radice = doc.percorso;
  for (let i = 0; i < livelli + 1; i++) radice = dirname(radice);
  return radice;
}

export async function estraiTesto(
  doc: DocumentoRif & { percorso: string },
  onAvanzamento: (a: AvanzamentoTrascrizione) => void,
  onPaginaOcr: OnPaginaOcr,
): Promise<string> {
  const ext = extname(doc.nome).slice(1).toLowerCase();

  // L'audio lavora direttamente sul percorso su disco, non su un buffer in
  // memoria: la trascrizione la fa un processo Python esterno a cui basta
  // il file, e la cache (src/main/trascrizione.ts) ha bisogno delle
  // informazioni del file reale (dimensione, data di modifica) per sapere
  // se un audio è già stato trascritto in passato.
  if (ESTENSIONI_AUDIO.has(ext)) {
    const testo = await trascriviAudio(doc.percorso, radicePratica(doc), doc.nome, onAvanzamento);
    return testo || '(Non ho riconosciuto parlato in questo file audio.)';
  }
  const buffer = await fs.readFile(doc.percorso);
  return estraiTestoDaBuffer(buffer, ext, doc.nome, onPaginaOcr);
}


// --- Immagini da guardare ------------------------------------------------------

export interface ImmagineDocumento {
  /** Nome con cui l'immagine si chiede a guarda_immagini: per gli allegati
   *  annidati il percorso dentro le email ("Originale.eml › IMG_1.jpg"). */
  nome: string;
  contenuto: Buffer;
}

// Le immagini di un documento della pratica, per mostrarle al modello come
// immagini vere e non solo come testo OCR: il file stesso se è una foto,
// altrimenti le foto allegate a un'email (anche dentro email inoltrate o
// PEC). Loghi e firme incorporati restano esclusi come per il testo.
export async function immaginiDelDocumento(doc: DocumentoRif & { percorso: string }): Promise<ImmagineDocumento[]> {
  const ext = extname(doc.nome).slice(1).toLowerCase();
  if (ESTENSIONI_IMMAGINE.has(ext)) return [{ nome: doc.nome, contenuto: await fs.readFile(doc.percorso) }];
  if (ext !== 'eml' && ext !== 'msg') return [];
  return immaginiEmail(await fs.readFile(doc.percorso), ext, '', 0);
}

async function immaginiEmail(buffer: Buffer, ext: 'eml' | 'msg', prefisso: string, profondita: number): Promise<ImmagineDocumento[]> {
  const allegati = ext === 'eml' ? (await apriEml(buffer)).allegati : apriMsg(buffer).allegati;
  const immagini: ImmagineDocumento[] = [];
  for (const a of allegati) {
    const tipo = estensioneAllegato(a);
    if (ESTENSIONI_IMMAGINE.has(tipo) && a.contenuto.length > 0) {
      immagini.push({ nome: prefisso + a.nome, contenuto: a.contenuto });
    } else if ((tipo === 'eml' || tipo === 'msg') && profondita < MAX_PROFONDITA_EMAIL) {
      try {
        immagini.push(...(await immaginiEmail(a.contenuto, tipo, `${prefisso}${a.nome} › `, profondita + 1)));
      } catch {
        // Un'email annidata illeggibile non deve togliere le altre foto.
      }
    }
  }
  return immagini;
}
