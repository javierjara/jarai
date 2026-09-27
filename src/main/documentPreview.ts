import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { ESTENSIONI_IMMAGINE } from './formatiDocumenti';

// Anteprima visiva dei documenti in "Le mie pratiche" (spec §5.6): solo PDF
// e immagini, gli unici due formati dove si può mostrare una pagina così
// com'è senza prima convertirla in qualcos'altro. Per gli altri formati
// (DOCX, DOC, RTF, EML, MSG, P7M, audio) il pannello resta con la nota
// testuale di sempre — JarAI li legge comunque in conversazione.
//
// A differenza dell'audio (protocollo dedicato "jarai-media://", serve il
// supporto a "Range" per file da decine di MB) una singola pagina PNG è
// piccola: un ipcMain.handle che restituisce i byte, come per ogni altro
// scambio di dati fra main e renderer, è già abbastanza.

const MIME_IMMAGINE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const percorsoSchema = z.string().min(1);
const anteprimaPdfSchema = z.object({ percorso: z.string().min(1), pagina: z.number().int().min(1) });

export function registraAnteprimaDocumenti(): void {
  ipcMain.handle('documenti:anteprima-pdf', async (_event, input: unknown) => {
    const { percorso, pagina } = anteprimaPdfSchema.parse(input);
    if (extname(percorso).slice(1).toLowerCase() !== 'pdf') throw new Error('Non è un PDF.');

    // Import dinamico, stesso motivo di documentTools.ts: pdf-parse si
    // appoggia a un pacchetto nativo (@napi-rs/canvas) che potrebbe mancare
    // su questo computer — meglio un errore contenuto qui che uno che
    // blocca l'avvio dell'app.
    const { PDFParse } = await import('pdf-parse');
    const dati = await fs.readFile(percorso);
    const parser = new PDFParse({ data: dati });
    try {
      const schermata = await parser.getScreenshot({ partial: [pagina], scale: 2, imageBuffer: true, imageDataUrl: false });
      const pag = schermata.pages[0];
      if (!pag) throw new Error('Pagina non trovata in questo PDF.');
      return { dati: pag.data, larghezza: pag.width, altezza: pag.height, totalePagine: schermata.total };
    } finally {
      await parser.destroy();
    }
  });

  ipcMain.handle('documenti:anteprima-immagine', async (_event, input: unknown) => {
    const percorso = percorsoSchema.parse(input);
    const ext = extname(percorso).slice(1).toLowerCase();
    if (!ESTENSIONI_IMMAGINE.has(ext)) throw new Error('Formato immagine non supportato.');
    const dati = await fs.readFile(percorso);
    return { dati, mime: MIME_IMMAGINE[ext] ?? 'application/octet-stream' };
  });
}
