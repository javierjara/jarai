import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { haChiave, leggiStatoCollegamento, rimuoviChiave, rimuoviStatoCollegamento, salvaChiave, salvaStatoCollegamento } from './claudeAuth';
import { attivaLicenza, rimuoviLicenza, statoLicenza } from './licenza';
import { verificaCollegamento } from './agentRunner';
import { annullaLogin, avviaLogin, disconnetti, inviaCodiceLogin } from './claudeLogin';
import { leggiUso } from './usage';

const chiaveSchema = z.string().min(10);
const licenzaSchema = z.string().trim().min(10);
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
    await rimuoviLicenza();
    await rimuoviStatoCollegamento();
  });

  // Licenza JarAI (src/main/licenza.ts): salvata solo se il servizio la
  // riconosce; l'esito aggiorna subito lo stato "Collegato" in cache.
  ipcMain.handle('claude:attiva-licenza', async (_event, licenzaInput: unknown) => {
    const stato = await attivaLicenza(licenzaSchema.parse(licenzaInput));
    if (stato.valida) {
      await salvaStatoCollegamento({ collegato: true, modalita: 'licenza', verificatoIl: new Date().toISOString() });
    }
    return stato;
  });

  ipcMain.handle('claude:stato-licenza', async () => statoLicenza());

  ipcMain.handle('claude:stato-chiave', async () => ({ presente: await haChiave() }));

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
}
