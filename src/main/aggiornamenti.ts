import { app, ipcMain, type BrowserWindow } from 'electron';
// electron-updater è CommonJS: in un progetto ESM ("type": "module", come
// jarai) l'import nominato non sempre funziona, perché Node deve indovinare
// gli export nominati di un modulo CJS analizzandolo staticamente — con
// questo pacchetto non ci riesce sempre. Si importa il default (l'intero
// module.exports) e si prende autoUpdater da lì.
import electronUpdaterPkg from 'electron-updater';
const { autoUpdater } = electronUpdaterPkg;

// Aggiornamenti (spec §12): un solo pulsante esplicito "Cerca aggiornamenti"
// in Impostazioni, mai un controllo silenzioso in background — stesso
// principio di ogni altra azione di jarai (niente succede da solo senza che
// l'avvocato lo chieda, vedi anche audioSetup.ts). autoDownload resta
// disattivato apposta: il download parte solo dopo che l'avvocato ha visto
// che c'è una versione nuova e ha scelto lui di scaricarla; l'installazione
// vera e propria (quit + riavvio) resta un secondo passo, altrettanto
// esplicito ("Riavvia e aggiorna").
//
// Non serve indicare qui repo/provider: electron-builder scrive da solo
// app-update.yml dentro il pacchetto in base alla sezione "publish" di
// package.json (vedi build.publish — GitHub, javierjara/jarai-releases).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

type EventoAggiornamento =
  | { tipo: 'controllo' }
  | { tipo: 'disponibile'; versione: string }
  | { tipo: 'non-disponibile' }
  | { tipo: 'progresso'; percentuale: number }
  | { tipo: 'scaricato'; versione: string }
  | { tipo: 'errore'; messaggio: string };

export function registraAggiornamenti(getWindow: () => BrowserWindow | null): void {
  const invia = (evento: EventoAggiornamento): void => {
    getWindow()?.webContents.send('aggiornamenti:evento', evento);
  };

  autoUpdater.on('checking-for-update', () => invia({ tipo: 'controllo' }));
  autoUpdater.on('update-available', (info) => invia({ tipo: 'disponibile', versione: info.version }));
  autoUpdater.on('update-not-available', () => invia({ tipo: 'non-disponibile' }));
  autoUpdater.on('download-progress', (progresso) => invia({ tipo: 'progresso', percentuale: progresso.percent }));
  autoUpdater.on('update-downloaded', (info) => invia({ tipo: 'scaricato', versione: info.version }));
  autoUpdater.on('error', (err) => invia({ tipo: 'errore', messaggio: err.message }));

  ipcMain.handle('aggiornamenti:controlla', async () => {
    // In sviluppo non esiste un pacchetto da confrontare (niente app.asar,
    // niente app-update.yml): electron-updater fallirebbe con un errore
    // criptico. Meglio dirlo subito con un messaggio comprensibile.
    if (!app.isPackaged) {
      invia({
        tipo: 'errore',
        messaggio: 'Il controllo aggiornamenti è disponibile solo nella versione installata, non in sviluppo.',
      });
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      invia({ tipo: 'errore', messaggio: err instanceof Error ? err.message : 'Controllo non riuscito.' });
    }
  });

  ipcMain.handle('aggiornamenti:scarica', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      invia({ tipo: 'errore', messaggio: err instanceof Error ? err.message : 'Download non riuscito.' });
    }
  });

  ipcMain.handle('aggiornamenti:installa', () => {
    autoUpdater.quitAndInstall();
  });
}
