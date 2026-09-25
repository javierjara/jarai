import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import MsgReader from '@kenjiuno/msgreader';
import forge from 'node-forge';
import Tesseract from 'tesseract.js';
import { trascriviAudio } from './trascrizione';
import { CARTELLA_PRINCIPALE, ESTENSIONI_AUDIO, ESTENSIONI_IMMAGINE, ESTENSIONI_LEGGIBILI } from './formatiDocumenti';

// Strumenti jarai-documenti (spec §6.2): solo lettura, scoperti per nome fra
// i documenti già indicizzati della pratica — mai un percorso libero passato
// dal modello. Un file fuori da questo elenco non è raggiungibile.
export interface DocumentoRif {
  nome: string;
  percorso?: string;
  cartella: string;
  tipo: string;
  pagine?: number;
}

const MAX_CARATTERI = 60_000;
// Sotto questa soglia una pagina PDF si considera scansionata (a volte resta
// solo un timbro o un numero di pagina come testo vero).
const MIN_CARATTERI_PAGINA = 20;
const MAX_PAGINE_OCR = 30;

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

async function estraiTestoDaBuffer(buffer: Buffer, estensione: string, nomeFile: string): Promise<string> {
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
      // passiamo a Tesseract. Tetto al numero di pagine perché l'OCR costa
      // qualche secondo a pagina e un fascicolo scansionato può averne centinaia.
      const daOcr = risultato.pages
        .filter((p) => p.text.trim().length < MIN_CARATTERI_PAGINA)
        .map((p) => p.num)
        .slice(0, MAX_PAGINE_OCR);
      const testoOcr = new Map<number, string>();
      if (daOcr.length > 0) {
        const schermate = await parser.getScreenshot({ partial: daOcr, scale: 2, imageBuffer: true, imageDataUrl: false });
        for (const s of schermate.pages) {
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
  if (ext === 'txt' || ext === 'eml') {
    return buffer.toString('utf-8');
  }
  if (ext === 'msg') {
    const dati = new MsgReader(buffer).getFileData();
    const allegati = dati.attachments?.map((a) => a.fileName).filter(Boolean).join(', ');
    const intestazione = [
      dati.senderName ? `Da: ${dati.senderName}` : null,
      dati.recipients?.length ? `A: ${dati.recipients.map((r) => r.name).join(', ')}` : null,
      dati.subject ? `Oggetto: ${dati.subject}` : null,
      allegati ? `Allegati: ${allegati}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return [intestazione, '', dati.body ?? ''].join('\n');
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
    const estensioneInterna = extname(nomeInterno).slice(1).toLowerCase();
    if (!estensioneInterna || !ESTENSIONI_LEGGIBILI.has(estensioneInterna) || estensioneInterna === 'p7m') {
      return '(Contenuto firmato estratto correttamente, ma il formato del documento originale non è tra quelli leggibili automaticamente.)';
    }
    return estraiTestoDaBuffer(estratto, estensioneInterna, nomeInterno);
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
  if (!doc.percorso) return null;
  if (doc.cartella === CARTELLA_PRINCIPALE) return dirname(doc.percorso);
  const livelli = doc.cartella.split('/').length;
  let radice = doc.percorso;
  for (let i = 0; i < livelli + 1; i++) radice = dirname(radice);
  return radice;
}

async function estraiTesto(doc: DocumentoRif & { percorso: string }): Promise<string> {
  const ext = extname(doc.nome).slice(1).toLowerCase();

  // L'audio lavora direttamente sul percorso su disco, non su un buffer in
  // memoria: la trascrizione la fa un processo Python esterno a cui basta
  // il file, e la cache (src/main/trascrizione.ts) ha bisogno delle
  // informazioni del file reale (dimensione, data di modifica) per sapere
  // se un audio è già stato trascritto in passato.
  if (ESTENSIONI_AUDIO.has(ext)) {
    const testo = await trascriviAudio(doc.percorso, radicePratica(doc), doc.nome);
    return testo || '(Non ho riconosciuto parlato in questo file audio.)';
  }
  const buffer = await fs.readFile(doc.percorso);
  return estraiTestoDaBuffer(buffer, ext, doc.nome);
}

// Dedup delle letture ripetute nella stessa conversazione (come in legis),
// tenuto per conversazioneId così sopravvive ai turni successivi via resume.
const lettiPerConversazione = new Map<string, Set<string>>();

export function creaServerDocumenti(conversazioneId: string, documenti: DocumentoRif[]): McpSdkServerConfigWithInstance {
  if (!lettiPerConversazione.has(conversazioneId)) lettiPerConversazione.set(conversazioneId, new Set());
  const letti = lettiPerConversazione.get(conversazioneId)!;

  const elencaDocumenti = tool(
    'elenca_documenti',
    'Elenca i documenti disponibili nella pratica selezionata in questa conversazione, con la loro cartella e se sono leggibili.',
    {},
    async () => {
      if (documenti.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Nessun documento importato in questa pratica.' }] };
      }
      const righe = documenti.map((d) => {
        const leggibile = d.percorso && ESTENSIONI_LEGGIBILI.has(extname(d.nome).slice(1).toLowerCase());
        return `- ${d.nome} — ${d.cartella}${leggibile ? '' : ' (non ancora leggibile automaticamente)'}`;
      });
      return { content: [{ type: 'text' as const, text: righe.join('\n') }] };
    },
  );

  const leggiDocumento = tool(
    'leggi_documento',
    'Legge il testo di un documento della pratica, dato il suo nome esatto come mostrato da elenca_documenti. Il testo dei PDF è diviso per pagina; le pagine scansionate vengono lette con OCR (può richiedere qualche secondo a pagina). Per i file audio (telefonate, deposizioni registrate) restituisce la trascrizione — può richiedere qualche minuto per registrazioni lunghe.',
    { nome: z.string().describe('Nome esatto del file, incluso il caso, come mostrato da elenca_documenti') },
    async ({ nome }) => {
      const doc = documenti.find((d) => d.nome === nome);
      if (!doc) {
        return {
          content: [{ type: 'text' as const, text: `Nessun documento chiamato "${nome}" in questa pratica. Usa elenca_documenti per vedere i nomi esatti.` }],
          isError: true,
        };
      }
      if (!doc.percorso) {
        return {
          content: [{ type: 'text' as const, text: `"${nome}" non ha un contenuto leggibile: non è stato importato da una cartella reale.` }],
          isError: true,
        };
      }
      if (letti.has(doc.percorso)) {
        return { content: [{ type: 'text' as const, text: `Hai già letto "${nome}" in questa conversazione: usa quanto hai già estratto.` }] };
      }
      try {
        const testo = await estraiTesto(doc as DocumentoRif & { percorso: string });
        letti.add(doc.percorso);
        const troncato = testo.length > MAX_CARATTERI;
        const corpo = troncato ? `${testo.slice(0, MAX_CARATTERI)}\n\n[testo troncato per lunghezza]` : testo;
        return { content: [{ type: 'text' as const, text: corpo || '(il documento risulta vuoto o senza testo estraibile)' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  return createSdkMcpServer({
    name: 'jarai-documenti',
    tools: [elencaDocumenti, leggiDocumento],
  });
}

export function pulisciLettureConversazione(conversazioneId: string): void {
  lettiPerConversazione.delete(conversazioneId);
}
