import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Solo diagnostica interna, mai mostrato all'avvocato (spec §0: zero codice
// o testo tecnico a schermo) — un file su disco che, in caso di problemi
// difficili da riprodurre da qui, si può chiedere di leggere per vedere il
// vero errore dietro un messaggio tradotto in italiano.
const LOG_PATH = () => join(app.getPath('userData'), 'errori.log');

export async function registraErroreGrezzo(contesto: string, dettaglio: string): Promise<void> {
  const riga = `[${new Date().toISOString()}] ${contesto}: ${dettaglio}\n`;
  await fs.appendFile(LOG_PATH(), riga).catch(() => undefined);
}
