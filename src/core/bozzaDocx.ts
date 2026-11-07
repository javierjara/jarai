import { AlignmentType, convertInchesToTwip, Document, Packer, Paragraph, TextRun } from 'docx';

// Usato dal desktop (src/main/bozze.ts) e dall'assistente di riserva sul
// server privato (src/server): niente Electron qui.

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
