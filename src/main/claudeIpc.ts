import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { haChiave, leggiStatoCollegamento, rimuoviChiave, rimuoviStatoCollegamento, salvaChiave } from './claudeAuth';
import { fermaMessaggio, inviaMessaggio, leggiUtilizzoAbbonamento, verificaCollegamento } from './agentRunner';
import { annullaLogin, avviaLogin, disconnetti, inviaCodiceLogin } from './claudeLogin';
import { leggiUso } from './usage';

const chiaveSchema = z.string().min(10);
const documentoRifSchema = z.object({
  nome: z.string(),
  percorso: z.string().optional(),
  cartella: z.string(),
  tipo: z.string(),
  pagine: z.number().optional(),
});
const invioSchema = z.object({
  conversazioneId: z.string().min(1),
  testo: z.string().min(1),
  qualita: z.enum(['Standard', 'Massima']),
  praticaNome: z.string().optional(),
  documenti: z.array(documentoRifSchema).optional(),
});
const conversazioneIdSchema = z.string().min(1);
const modalitaLoginSchema = z.enum(['console', 'claudeai']);
const codiceLoginSchema = z.string().min(1);

export function registraCollegamentoClaude(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('claude:verifica', async () => verificaCollegamento());

  ipcMain.handle('claude:stato-collegamento-salvato', async () => leggiStatoCollegamento());

  ipcMain.handle('claude:salva-chiave', async (_event, chiaveInput: unknown) => {
    const chiave = chiaveSchema.parse(chiaveInput);
    await salvaChiave(chiave);
  });

  ipcMain.handle('claude:rimuovi-chiave', async () => {
    await rimuoviChiave();
    // La chiave rimossa invalida lo stato "Collegato" cache: senza questo, alla
    // riapertura dell'app comparirebbe ancora "Collegato" con un accesso che
    // non c'è più.
    await rimuoviStatoCollegamento();
  });

  // Disconnetti (pulsante unico, spec §12): copre sia la chiave dello studio
  // sia l'account ufficiale, qualunque dei due sia quello attivo — l'utente
  // vede solo "Collegato" / "Non collegato", mai quale meccanismo usa.
  ipcMain.handle('claude:disconnetti', async () => {
    await disconnetti();
    await rimuoviChiave();
    await rimuoviStatoCollegamento();
  });

  ipcMain.handle('claude:stato-chiave', async () => ({ presente: await haChiave() }));

  ipcMain.handle('claude:invia', (_event, payloadInput: unknown) => {
    const payload = invioSchema.parse(payloadInput);
    const win = getWindow();
    if (!win) return;
    void inviaMessaggio(payload, win.webContents);
  });

  ipcMain.handle('claude:ferma', (_event, conversazioneIdInput: unknown) => {
    const conversazioneId = conversazioneIdSchema.parse(conversazioneIdInput);
    fermaMessaggio(conversazioneId);
  });

  ipcMain.handle('claude:avvia-login', (_event, modalitaInput: unknown) => {
    const modalita = modalitaLoginSchema.parse(modalitaInput);
    const win = getWindow();
    if (!win) return;
    void avviaLogin(modalita, (evento) => {
      if (!win.webContents.isDestroyed()) win.webContents.send('claude:login-evento', evento);
    });
  });

  ipcMain.handle('claude:invia-codice-login', (_event, codiceInput: unknown) => {
    const codice = codiceLoginSchema.parse(codiceInput);
    inviaCodiceLogin(codice);
  });

  ipcMain.handle('claude:annulla-login', () => {
    annullaLogin();
  });

  ipcMain.handle('claude:uso', async () => leggiUso());

  ipcMain.handle('claude:uso-abbonamento', async () => leggiUtilizzoAbbonamento());
}
