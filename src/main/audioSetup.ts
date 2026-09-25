import { ipcMain, type BrowserWindow } from 'electron';
import { eseguibilePythonAttivo, installaPythonPrivato, installazionePrivataSupportata } from './pythonRuntime';

// IPC per la scheda "Trascrizione audio" in Impostazioni (spec §12): lo
// stato mostra solo "attiva o no", mai il dettaglio tecnico (Python di
// sistema o privato) — stesso principio già usato per il collegamento
// Claude ("Collegato"/"Non collegato", mai quale meccanismo c'è dietro).
export function registraAudioSetup(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('audio:stato', async () => {
    const attivo = await eseguibilePythonAttivo();
    return {
      disponibile: attivo !== null,
      installazioneAutomaticaDisponibile: installazionePrivataSupportata(),
    };
  });

  ipcMain.handle('audio:installa', async () => {
    try {
      await installaPythonPrivato((fase) => {
        getWindow()?.webContents.send('audio:progresso', fase);
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, errore: err instanceof Error ? err.message : 'Installazione non riuscita.' };
    }
  });
}
