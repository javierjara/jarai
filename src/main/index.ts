import './polyfillPdf';
import { app, BrowserWindow, nativeImage, session, shell } from 'electron';
import { join } from 'node:path';
import { registraGestionePratiche } from './pratiche';
import { registraCollegamentoClaude } from './claudeIpc';
import { registraPersistenza } from './store';
import { registraBozze } from './bozze';

const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
let mainWindow: BrowserWindow | null = null;

function ricaricaFinestra(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Fase 1 (Guscio): nessuna logica di agente, nessun accesso al filesystem
// dell'avvocato. Solo la shell Electron con le schermate di legis e dati finti.
// La sicurezza però è quella definitiva fin da subito (spec §2.3), perché è
// più facile mantenerla stretta che stringerla dopo.

// In sviluppo l'icona sta dentro il progetto; impacchettata, l'app.asar non
// è un percorso reale per un file da caricare come immagine — electron-
// builder copia icon.png accanto alle altre risorse (extraResources), da lì
// si legge con process.resourcesPath invece di app.getAppPath().
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(app.getAppPath(), 'build/icon.png');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    title: 'jarai',
    backgroundColor: '#f8f7f4',
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Su macOS, quando lo schermo si spegne il processo GPU di Electron
      // viene a volte terminato dal sistema e la finestra resta vuota senza
      // che l'app se ne accorga da sola (bug noto di Chromium/Electron, non
      // un vero reset dei dati: jarai-dati.json non viene toccato). Con
      // backgroundThrottling disattivato la finestra resta "viva" mentre non
      // è visibile, e i due handler sotto ricaricano l'interfaccia se il
      // processo di rendering o quello GPU muoiono comunque.
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.on('ready-to-show', () => win.show());

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[did-fail-load]', code, description);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', details.reason);
    if (details.reason !== 'clean-exit') ricaricaFinestra(win);
  });

  // Nessuna nuova finestra non gestita: i link esterni si aprono nel browser
  // di sistema, e solo se sono https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // In sviluppo l'eseguibile è Electron stesso, quindi il Dock mostra la sua
  // icona di default finché non gliene diamo una esplicitamente. Nel
  // pacchetto finale l'icona è già quella giusta (build/icon.icns via
  // electron-builder), qui serve solo per l'esperienza da `npm run dev`.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const devIcon = nativeImage.createFromPath(appIconPath);
    if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
  }

  // CSP restrittiva: niente script remoti, niente eval. In sviluppo il
  // server Vite ha bisogno di script inline e di una connessione websocket
  // per l'HMR; quella policy più permissiva non esiste nel pacchetto finale,
  // che carica solo file locali.
  const csp = devServerUrl
    ? "default-src 'self' http://localhost:*; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self';";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  registraGestionePratiche(() => mainWindow);
  registraCollegamentoClaude(() => mainWindow);
  registraPersistenza();
  registraBozze(() => mainWindow);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Il crash del processo GPU (frequente su macOS dopo lo spegnimento dello
// schermo) non chiude la finestra: la lascia semplicemente vuota. Senza
// questo handler l'unico modo per l'avvocato di "tornare" sarebbe chiudere e
// riaprire l'app — i dati su disco non sono mai a rischio, solo la finestra.
app.on('child-process-gone', (_event, details) => {
  console.error('[child-process-gone]', details.type, details.reason);
  if (details.type === 'GPU' && mainWindow) ricaricaFinestra(mainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
