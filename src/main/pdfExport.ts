import { BrowserWindow } from 'electron';
import { marked } from 'marked';

// Markdown → PDF per il pannello documento (spec §5.6, "Salva in PDF").
// Stesso ingresso di generaDocxBuffer (bozze.ts) — il markdown di una bozza
// — ma l'uscita passa dal motore di stampa di Chromium invece che dalla
// libreria docx: si converte il markdown in un HTML semplice con `marked`,
// lo si carica in una finestra invisibile (mai mostrata all'avvocato) e si
// chiede a Electron di stamparla in PDF. Pattern standard di Electron per
// generare PDF, coerente con "Esportazione: docx + PDF via stampa Chromium"
// della spec (§2.1) — nessuna dipendenza nativa in più.

// Stile minimo, pensato per un atto: margini gestiti da printToPDF stesso
// (vedi sotto), qui solo font e spaziatura leggibili su pagina A4.
const STILE = `
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.5; color: #111; }
  h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; }
  h1 { font-size: 16pt; text-align: center; text-decoration: underline; }
  h2 { font-size: 14pt; text-align: center; text-decoration: underline; }
  h3 { font-size: 13pt; }
  p { text-align: justify; text-indent: 1.5em; }
  li { text-align: left; }
  hr { border: none; border-top: 1px solid #333; margin: 1em 0; }
`;

function markdownInHtml(markdown: string): string {
  const corpo = marked.parse(markdown, { async: false, breaks: true }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STILE}</style></head><body>${corpo}</body></html>`;
}

export async function generaPdfBuffer(markdown: string): Promise<Buffer> {
  const html = markdownInHtml(markdown);
  // show: false — questa finestra non deve mai comparire, serve solo come
  // motore di rendering per printToPDF.
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      // Valori in pollici (API printToPDF attuale; marginType non esiste
      // più): stessi margini del .docx generato da bozze.ts (1"/1.2").
      margins: { top: 1, bottom: 1, left: 1.2, right: 1.2 },
      pageSize: 'A4',
      printBackground: false,
    });
  } finally {
    win.destroy();
  }
}
