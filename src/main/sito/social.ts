import { BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { disegnaPagine, escape, percorsoImmagine, tipoImmagine } from './immagini';
import { ErroreSito } from './payload';

// Carosello Instagram (Studio digitale): le slide proposte dall'assistente
// diventano immagini 1080×1080 da salvare e pubblicare a mano. La
// pubblicazione diretta su Instagram richiede un account Meta Business e
// arriverà dopo.

export interface DatiCarosello {
  slide: { titoletto: string; testo: string }[];
  firma: string;
  sito: string;
  /** Foto di copertina come sfondo della prima slide (nome file locale). */
  sfondo?: string;
}

function htmlSlide(i: number, n: number, s: { titoletto: string; testo: string }, dati: DatiCarosello, sfondo: string | null): string {
  const prima = i === 0;
  const ultima = i === n - 1;
  const scura = prima || ultima;
  const corpo = prima ? (s.testo.length > 55 ? 76 : 88) : ultima ? 64 : s.testo.length > 140 ? 46 : 52;
  const fondo = prima && sfondo
    ? `url('${sfondo}') center/cover`
    : scura
      ? 'linear-gradient(150deg,#1d2a3f,#34507a)'
      : '#f6f3ee';
  const velo = prima && sfondo ? '<div class="velo"></div>' : '';
  // Il grassetto Markdown delle slide (**...**) diventa <b>.
  const testo = escape(s.testo).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1080px;height:1080px;overflow:hidden}
    body{background:${fondo};color:${scura ? '#fff' : '#1f1d1a'};font-family:Georgia,"Times New Roman",serif;position:relative}
    .velo{position:absolute;inset:0;background:linear-gradient(to top,rgba(20,28,42,.94),rgba(20,28,42,.4))}
    .in{position:absolute;inset:0;padding:96px 96px 84px;display:flex;flex-direction:column;justify-content:space-between}
    .k{font-family:Menlo,Consolas,monospace;font-size:26px;letter-spacing:.16em;text-transform:uppercase;opacity:.72}
    .t{font-size:${corpo}px;line-height:${prima || ultima ? 1.14 : 1.32}}
    .t b{font-weight:700}
    .f{display:flex;justify-content:space-between;font-size:30px;opacity:.8}
    .pg{position:absolute;top:60px;right:72px;font-family:Menlo,Consolas,monospace;font-size:24px;opacity:.6}
  </style></head><body>${velo}<div class="pg">${i + 1}/${n}</div><div class="in">
    <div class="k">${escape(s.titoletto)}</div>
    <div class="t">${testo}</div>
    <div class="f"><span>${escape(ultima ? dati.sito : dati.firma)}</span><span>${prima ? 'scorri →' : ''}</span></div>
  </div></body></html>`;
}

async function sfondoComeDataUrl(file?: string): Promise<string | null> {
  if (!file) return null;
  try {
    const byte = await fs.readFile(percorsoImmagine(file));
    return `data:${tipoImmagine(file)};base64,${byte.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function salvaCarosello(dati: DatiCarosello, finestra: BrowserWindow | null, nomeBase: string): Promise<string | null> {
  if (!dati.slide.length) throw new ErroreSito('Il carosello non ha slide.');
  const opzioni = { title: 'Dove salvo le immagini del carosello?', properties: ['openDirectory' as const, 'createDirectory' as const] };
  const scelta = finestra ? await dialog.showOpenDialog(finestra, opzioni) : await dialog.showOpenDialog(opzioni);
  const cartella = scelta.filePaths[0];
  if (scelta.canceled || !cartella) return null;
  const sfondo = await sfondoComeDataUrl(dati.sfondo);
  const immagini = await disegnaPagine(
    dati.slide.map((s, i) => htmlSlide(i, dati.slide.length, s, dati, sfondo)),
    1080,
    1080,
  );
  const base = nomeBase.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'carosello';
  await Promise.all(immagini.map((img, i) => fs.writeFile(join(cartella, `${base}-${i + 1}.png`), img)));
  return cartella;
}
