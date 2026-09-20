import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { AlignmentType, convertInchesToTwip, Document, Packer, Paragraph, TextRun } from 'docx';

// Strumenti jarai-bozze (spec §6.2). Solo `crea_bozza` per ora: propone il
// testo all'avvocato in chat (livello "Libero", nessuna scrittura su disco).
// Il salvataggio vero — l'unico passaggio che tocca il disco — resta
// un'azione esplicita dell'avvocato dal pannello del documento, non
// un'autorizzazione data al modello: più semplice del PermissionGate
// completo di Fase 5, e comunque coerente con "l'avvocato decide" (spec §0).
export type EventoBozza = { titolo: string; contenuto: string };

export function creaServerBozze(onBozza: (bozza: EventoBozza) => void): McpSdkServerConfigWithInstance {
  const creaBozza = tool(
    'crea_bozza',
    "Propone una bozza di documento all'avvocato (atto, lettera, comparsa...). Il testo va in Markdown ben strutturato: ## per i titoli di sezione, elenchi puntati/numerati riga per riga, **grassetto** solo sui punti chiave. Non salva nulla: l'avvocato la vede nel pannello e decide se salvarla in Word.",
    {
      titolo: z.string().describe('Titolo breve della bozza, es. "Atto di citazione — Rossi c. Bianchi"'),
      contenuto: z.string().describe('Testo completo della bozza in Markdown'),
    },
    async ({ titolo, contenuto }) => {
      onBozza({ titolo, contenuto });
      return {
        content: [{ type: 'text' as const, text: `Bozza «${titolo}» mostrata all'avvocato nel pannello. Non è stata salvata su disco.` }],
      };
    },
  );

  return createSdkMcpServer({ name: 'jarai-bozze', tools: [creaBozza] });
}

// ─── Markdown → Word, porting diretto di legal-ai/src/lib/export.ts ───────
// (stessa logica di formattazione: niente HeadingLevel di default di Word,
// che colora i titoli con il tema — titoli centrati/grassetto/sottolineati
// come in un atto vero).

const PARA_INDENT_TWIP = convertInchesToTwip(0.3);

function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2]) runs.push(new TextRun({ text: m[2], bold: true }));
    else if (m[3]) runs.push(new TextRun({ text: m[3], italics: true }));
    else if (m[4]) runs.push(new TextRun({ text: m[4], font: 'Courier New', size: 18 }));
    else if (m[5]) runs.push(new TextRun({ text: m[5] }));
  }
  return runs.length ? runs : [new TextRun({ text })];
}

function parseMd(markdown: string): Paragraph[] {
  const lines = markdown.split('\n');
  const paragraphs: Paragraph[] = [];

  for (const line of lines) {
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 120 },
          children: [new TextRun({ text: '* * * *', bold: true })],
        }),
      );
    } else if (/^### (.+)/.test(line)) {
      paragraphs.push(
        new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: line.replace(/^### /, ''), bold: true, size: 22 })] }),
      );
    } else if (/^## (.+)/.test(line)) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 100 },
          children: [new TextRun({ text: line.replace(/^## /, ''), bold: true, underline: {}, size: 24 })],
        }),
      );
    } else if (/^# (.+)/.test(line)) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 160 },
          children: [new TextRun({ text: line.replace(/^# /, ''), bold: true, underline: {}, size: 28 })],
        }),
      );
    } else if (/^[-*] (.+)/.test(line)) {
      paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(line.replace(/^[-*] /, '')) }));
    } else if (/^\d+\. (.+)/.test(line)) {
      paragraphs.push(new Paragraph({ numbering: { reference: 'default-numbering', level: 0 }, children: inlineRuns(line.replace(/^\d+\. /, '')) }));
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ text: '' }));
    } else {
      paragraphs.push(new Paragraph({ children: inlineRuns(line), alignment: AlignmentType.JUSTIFIED, indent: { firstLine: PARA_INDENT_TWIP } }));
    }
  }

  return paragraphs;
}

export async function generaDocxBuffer(markdown: string): Promise<Buffer> {
  const doc = new Document({
    numbering: {
      config: [{ reference: 'default-numbering', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }] }],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1.2),
              right: convertInchesToTwip(1.2),
            },
          },
        },
        children: parseMd(markdown),
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export interface EsitoSalvataggio {
  salvato: boolean;
  percorso?: string;
}

export async function salvaBozzaDocx(win: BrowserWindow | null, titolo: string, markdown: string): Promise<EsitoSalvataggio> {
  const nomeFile = `${titolo.replace(/[/\\:*?"<>|]/g, ' ').trim() || 'documento'}.docx`;
  const opzioni = { defaultPath: nomeFile, filters: [{ name: 'Documento Word', extensions: ['docx'] }] };
  const risultato = win ? await dialog.showSaveDialog(win, opzioni) : await dialog.showSaveDialog(opzioni);
  if (risultato.canceled || !risultato.filePath) return { salvato: false };

  const buffer = await generaDocxBuffer(markdown);
  await fs.writeFile(risultato.filePath, buffer);
  return { salvato: true, percorso: risultato.filePath };
}

const salvaBozzaSchema = z.object({ titolo: z.string().min(1), contenuto: z.string().min(1) });

export function registraBozze(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('bozze:salva-docx', async (_event, input: unknown) => {
    const { titolo, contenuto } = salvaBozzaSchema.parse(input);
    return salvaBozzaDocx(getWindow(), titolo, contenuto);
  });
}
