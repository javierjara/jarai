import { app, BrowserWindow, dialog, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { URL_PROXY, leggiLicenza } from '../licenza';
import { ErroreSito, elencaMediaSito, scaricaDalSito, statoSito } from './payload';

// Immagine di copertina degli articoli (Studio digitale): in cima
// all'articolo e come anteprima su Google, LinkedIn e WhatsApp (1200×630).
// Quattro provenienze:
//  - copertina: creata qui, titolo dell'articolo nello stile dello studio;
//  - foto: archivio Pixabay (licenza gratuita anche commerciale), cercata
//    tramite il proxy JarAI che custodisce la chiave; la foto scelta viene
//    scaricata e poi caricata sul sito (Pixabay vieta l'hotlinking);
//  - sito: un'immagine già presente nella libreria del sito;
//  - caricata: un file scelto dall'avvocato.
// L'immagine scelta vive come file in userData/sito-immagini; va sul sito
// solo con l'invio della bozza (payload.ts), quindi sempre su un clic.
// Il renderer non carica mai URL remoti (CSP): riceve anteprime data:.

const CARTELLA = () => join(app.getPath('userData'), 'sito-immagini');
const TIMEOUT_MS = 20_000;
const MAX_BYTE = 10 * 1024 * 1024;
const ESTENSIONI: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export type OrigineCopertina = 'copertina' | 'foto' | 'sito' | 'caricata';

// Immagine scelta per un articolo (salvata con la conversazione).
export interface Copertina {
  file: string;
  alt: string;
  origine: OrigineCopertina;
  /** Per le foto: "Foto di autore su Pixabay". */
  credito?: string;
  /** Id nella libreria del sito, dopo il caricamento (o se presa da lì). */
  mediaId?: number | string;
}

// Proposta mostrata nella scelta: "rif" dice a scegliImmagine cosa fare.
export interface Proposta {
  chiave: string;
  origine: Exclude<OrigineCopertina, 'caricata'>;
  etichetta: string;
  anteprima: string;
  alt: string;
  credito?: string;
  rif: string;
}

export interface DatiCopertina {
  titolo: string;
  categoria?: string;
  firma?: string;
}

async function cartella(): Promise<string> {
  const dir = CARTELLA();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Solo nomi di file dentro la cartella delle immagini: il renderer non può
// far leggere o inviare altro.
export function percorsoImmagine(file: string): string {
  if (file !== basename(file) || !ESTENSIONI[extname(file).toLowerCase()]) {
    throw new ErroreSito('Immagine non valida.');
  }
  return join(CARTELLA(), file);
}

export function tipoImmagine(file: string): string {
  return ESTENSIONI[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// Anteprima rimpicciolita in JPEG. Se nativeImage non sa leggere il formato
// (WebP su Windows), passa i byte originali: Chromium li mostra comunque.
function dataUrlDa(byte: Buffer, larghezza: number, tipo = 'image/jpeg'): string {
  const img = nativeImage.createFromBuffer(byte);
  if (img.isEmpty()) return byte.length ? `data:${tipo};base64,${byte.toString('base64')}` : '';
  const { width } = img.getSize();
  const ridotta = width > larghezza ? img.resize({ width: larghezza, quality: 'good' }) : img;
  return `data:image/jpeg;base64,${ridotta.toJPEG(82).toString('base64')}`;
}

export async function anteprimaImmagine(file: string, larghezza = 640): Promise<string> {
  try {
    return dataUrlDa(await fs.readFile(percorsoImmagine(file)), larghezza, tipoImmagine(file));
  } catch {
    return '';
  }
}

async function scarica(url: string): Promise<Buffer> {
  let risposta: Response;
  try {
    risposta = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ErroreSito('Non riesco a scaricare l\'immagine. Controlla la connessione.');
  }
  if (!risposta.ok) throw new ErroreSito('L\'immagine non è più disponibile.');
  const byte = Buffer.from(await risposta.arrayBuffer());
  if (byte.length > MAX_BYTE) throw new ErroreSito('L\'immagine è troppo grande (massimo 10 MB).');
  return byte;
}

// Riporta l'immagine a 1200×630 al centro, in JPEG: il formato delle
// anteprime social, e pesa poco sul sito.
async function salvaRitagliata(byte: Buffer): Promise<string> {
  const img = nativeImage.createFromBuffer(byte);
  if (img.isEmpty()) throw new ErroreSito('Il file non è un\'immagine leggibile (usa JPG o PNG).');
  const { width, height } = img.getSize();
  if (width < 600 || height < 315) throw new ErroreSito('L\'immagine è troppo piccola: serve almeno 600×315 pixel, meglio 1200×630.');
  const rapporto = 1200 / 630;
  const taglio =
    width / height > rapporto
      ? { x: Math.round((width - height * rapporto) / 2), y: 0, width: Math.round(height * rapporto), height }
      : { x: 0, y: Math.round((height - width / rapporto) / 2), width, height: Math.round(width / rapporto) };
  const finale = img.crop(taglio).resize({ width: 1200, height: 630, quality: 'best' });
  const file = `${randomUUID()}.jpg`;
  await fs.writeFile(join(await cartella(), file), finale.toJPEG(86));
  return file;
}

// ─── Copertine create da JarAI ──────────────────────────────────────────

const STILI = {
  scura: { etichetta: 'Copertina scura', sfondo: 'linear-gradient(135deg,#1d2a3f,#34507a)', testo: '#fff', riga: 'transparent' },
  chiara: { etichetta: 'Copertina chiara', sfondo: '#f6f3ee', testo: '#1f1d1a', riga: '#8f2f24' },
} as const;

export function escape(testo: string): string {
  return testo.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function htmlCopertina(stile: keyof typeof STILI, dati: DatiCopertina): string {
  const s = STILI[stile];
  // Titoli lunghi: carattere più piccolo, sempre dentro l'immagine.
  const corpo = dati.titolo.length > 80 ? 54 : dati.titolo.length > 55 ? 64 : 76;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1200px;height:630px;overflow:hidden}
    body{background:${s.sfondo};color:${s.testo};font-family:Georgia,"Times New Roman",serif;position:relative}
    .riga{position:absolute;left:0;top:0;bottom:0;width:26px;background:${s.riga}}
    .in{position:absolute;inset:0;padding:70px 90px 64px 96px;display:flex;flex-direction:column;justify-content:space-between}
    .k{font-family:Menlo,Consolas,monospace;font-size:24px;letter-spacing:.16em;text-transform:uppercase;opacity:.72}
    .t{font-size:${corpo}px;line-height:1.14;max-width:960px}
    .f{font-size:30px;opacity:.82}
  </style></head><body><div class="riga"></div><div class="in">
    <div class="k">${escape(dati.categoria ?? '')}</div>
    <div class="t">${escape(dati.titolo)}</div>
    <div class="f">${escape(dati.firma ?? '')}</div>
  </div></body></html>`;
}

// Una sola finestra invisibile per tutte le copertine, caricate una dopo
// l'altra: chiuderla e riaprirla di seguito fa fallire il secondo caricamento.
export async function disegnaPagine(pagine: string[], larghezza = 1200, altezza = 630): Promise<Buffer[]> {
  const win = new BrowserWindow({
    width: larghezza,
    height: altezza,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true },
  });
  try {
    const immagini: Buffer[] = [];
    for (const html of pagine) {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      // Un attimo per i caratteri di sistema prima della cattura.
      await new Promise((r) => setTimeout(r, 150));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: larghezza, height: altezza });
      immagini.push(img.resize({ width: larghezza, height: altezza, quality: 'best' }).toPNG());
    }
    return immagini;
  } finally {
    win.destroy();
  }
}

export async function copertineProposte(dati: DatiCopertina): Promise<Proposta[]> {
  const dir = await cartella();
  const stili = ['scura', 'chiara'] as const;
  const immagini = await disegnaPagine(stili.map((stile) => htmlCopertina(stile, dati)));
  return Promise.all(
    stili.map(async (stile, i) => {
      const file = `copertina-${randomUUID()}.png`;
      await fs.writeFile(join(dir, file), immagini[i]);
      return {
        chiave: `copertina-${stile}`,
        origine: 'copertina' as const,
        etichetta: STILI[stile].etichetta,
        anteprima: dataUrlDa(immagini[i], 480),
        alt: `«${dati.titolo}»${dati.firma ? ` — ${dati.firma}` : ''}`,
        rif: file,
      };
    }),
  );
}

// ─── Foto (Pixabay, tramite il proxy) ────────────────────────────────────

interface FotoProxy {
  id: string;
  descrizione: string;
  autore: string;
  pagina: string;
  anteprima: string;
  grande: string;
}

export async function cercaFoto(testo: string, titolo: string): Promise<Proposta[]> {
  const chiave = await leggiLicenza();
  if (!chiave) throw new ErroreSito('Serve una licenza JarAI attiva per cercare le foto.');
  let risposta: Response;
  try {
    risposta = await fetch(`${URL_PROXY}/v1/foto?q=${encodeURIComponent(testo)}`, {
      headers: { 'x-api-key': chiave },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ErroreSito('Non riesco a cercare le foto. Controlla la connessione.');
  }
  if (risposta.status === 503) throw new ErroreSito('La ricerca delle foto non è ancora attiva per JarAI.');
  if (!risposta.ok) throw new ErroreSito('La ricerca delle foto non è disponibile in questo momento.');
  const { foto } = (await risposta.json()) as { foto: FotoProxy[] };
  const proposte = await Promise.all(
    foto.map(async (f): Promise<Proposta | null> => {
      try {
        return {
          chiave: f.id,
          origine: 'foto',
          etichetta: `Foto di ${f.autore}`,
          anteprima: dataUrlDa(await scarica(f.anteprima), 480),
          // Le parole chiave di Pixabay sono in inglese: meglio una base italiana da correggere.
          alt: `Immagine dell'articolo «${titolo}»`,
          credito: `Foto di ${f.autore} su Pixabay`,
          rif: f.grande,
        };
      } catch {
        return null;
      }
    }),
  );
  return proposte.filter((p): p is Proposta => p !== null && p.anteprima !== '');
}

// ─── Libreria del sito ──────────────────────────────────────────────────

export async function immaginiDelSito(): Promise<Proposta[]> {
  if (!(await statoSito()).collegato) return [];
  const media = await elencaMediaSito(12);
  const proposte = await Promise.all(
    media.map(async (m): Promise<Proposta | null> => {
      try {
        return {
          chiave: `sito-${m.id}`,
          origine: 'sito',
          etichetta: m.alt || m.nomeFile,
          anteprima: dataUrlDa(await scaricaDalSito(m.urlAnteprima), 480, m.tipo),
          alt: m.alt,
          rif: JSON.stringify({ id: m.id, url: m.urlGrande, tipo: m.tipo }),
        };
      } catch {
        return null;
      }
    }),
  );
  return proposte.filter((p): p is Proposta => p !== null && p.anteprima !== '');
}

// ─── Scelta ─────────────────────────────────────────────────────────────

export async function scegliProposta(p: Pick<Proposta, 'origine' | 'rif' | 'alt' | 'credito'>): Promise<Copertina> {
  if (p.origine === 'copertina') {
    percorsoImmagine(p.rif);
    return { file: p.rif, alt: p.alt, origine: 'copertina' };
  }
  if (p.origine === 'foto') {
    const url = new URL(p.rif);
    if (url.protocol !== 'https:' || !['pixabay.com', 'cdn.pixabay.com'].includes(url.hostname)) throw new ErroreSito('Foto non valida.');
    return { file: await salvaRitagliata(await scarica(url.toString())), alt: p.alt, origine: 'foto', credito: p.credito };
  }
  const { id, url, tipo } = JSON.parse(p.rif) as { id: number | string; url: string; tipo: string };
  // Già sul sito: si riusa lo stesso elemento della libreria, senza
  // ricaricarlo. La copia locale serve solo all'anteprima.
  const estensione = Object.entries(ESTENSIONI).find(([, t]) => t === tipo)?.[0] ?? '.jpg';
  const file = `${randomUUID()}${estensione}`;
  await fs.writeFile(join(await cartella(), file), await scaricaDalSito(url));
  return { file, alt: p.alt, origine: 'sito', mediaId: id };
}

export async function caricaDalComputer(finestra: BrowserWindow | null): Promise<Copertina | null> {
  const opzioni = {
    title: 'Scegli l\'immagine di copertina',
    properties: ['openFile' as const],
    filters: [{ name: 'Immagini', extensions: ['jpg', 'jpeg', 'png'] }],
  };
  const scelta = finestra ? await dialog.showOpenDialog(finestra, opzioni) : await dialog.showOpenDialog(opzioni);
  const percorso = scelta.filePaths[0];
  if (scelta.canceled || !percorso) return null;
  if (!['.jpg', '.jpeg', '.png'].includes(extname(percorso).toLowerCase())) throw new ErroreSito('Usa un\'immagine JPG o PNG.');
  const { size } = await fs.stat(percorso);
  if (size > MAX_BYTE) throw new ErroreSito('L\'immagine è troppo grande (massimo 10 MB).');
  return { file: await salvaRitagliata(await fs.readFile(percorso)), alt: '', origine: 'caricata' };
}
