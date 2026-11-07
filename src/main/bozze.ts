import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { generaPdfBuffer } from './pdfExport';

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

// Markdown → Word: src/core/bozzaDocx.ts (lo usa anche il server privato).
import { generaDocxBuffer } from '../core/bozzaDocx';
export { generaDocxBuffer };


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

// Stesso schema di salvaBozzaDocx, solo il formato cambia (pdfExport.ts
// invece di docx) — pannello documento, spec §5.6, "Salva in PDF".
export async function salvaBozzaPdf(win: BrowserWindow | null, titolo: string, markdown: string): Promise<EsitoSalvataggio> {
  const nomeFile = `${titolo.replace(/[/\\:*?"<>|]/g, ' ').trim() || 'documento'}.pdf`;
  const opzioni = { defaultPath: nomeFile, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
  const risultato = win ? await dialog.showSaveDialog(win, opzioni) : await dialog.showSaveDialog(opzioni);
  if (risultato.canceled || !risultato.filePath) return { salvato: false };

  const buffer = await generaPdfBuffer(markdown);
  await fs.writeFile(risultato.filePath, buffer);
  return { salvato: true, percorso: risultato.filePath };
}

const salvaBozzaSchema = z.object({ titolo: z.string().min(1), contenuto: z.string().min(1) });

export function registraBozze(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('bozze:salva-docx', async (_event, input: unknown) => {
    const { titolo, contenuto } = salvaBozzaSchema.parse(input);
    return salvaBozzaDocx(getWindow(), titolo, contenuto);
  });

  ipcMain.handle('bozze:salva-pdf', async (_event, input: unknown) => {
    const { titolo, contenuto } = salvaBozzaSchema.parse(input);
    return salvaBozzaPdf(getWindow(), titolo, contenuto);
  });
}
