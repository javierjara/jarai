import { contextBridge, ipcRenderer } from 'electron';

// Duplicate (non importate) dai tipi renderer con lo stesso nome: preload e
// renderer sono due programmi TypeScript separati (tsconfig.node.json vs
// tsconfig.web.json), quindi la forma va tenuta manualmente allineata.
interface ImportoCartella {
  cartellaPercorso: string;
  cartellaNome: string;
  file: {
    nome: string;
    percorso: string;
    cartella: string;
    estensione: string;
    dimensione: number;
    modificatoIl: string;
  }[];
}

interface EsitoVerifica {
  collegato: boolean;
  modalita?: 'chiave' | 'account';
  messaggio?: string;
}

interface StatoCollegamentoSalvato extends EsitoVerifica {
  verificatoIl: string;
}

interface InvioPayload {
  conversazioneId: string;
  testo: string;
  qualita: 'Standard' | 'Massima';
  praticaNome?: string;
  documenti?: {
    nome: string;
    percorso?: string;
    cartella: string;
    tipo: string;
    pagine?: number;
  }[];
}

type EventoAgente =
  | { tipo: 'delta'; conversazioneId: string; testo: string }
  | { tipo: 'attivita'; conversazioneId: string; testo: string }
  | { tipo: 'completato'; conversazioneId: string; testo: string; costoUsd: number }
  | { tipo: 'errore'; conversazioneId: string; messaggio: string }
  | { tipo: 'bozza'; conversazioneId: string; titolo: string; contenuto: string };

type EventoLogin =
  | { tipo: 'url'; url: string }
  | { tipo: 'attesa-codice' }
  | { tipo: 'completato' }
  | { tipo: 'errore'; messaggio: string };

interface RiepilogoUso {
  totaleUsd: number;
  questoMeseUsd: number;
  numeroRichieste: number;
  ultime: { ts: string; modello: string; costoUsd: number }[];
}

interface FinestraUtilizzo {
  percentuale: number | null;
  siAzzeraIl: string | null;
}
interface UtilizzoAbbonamento {
  disponibile: boolean;
  tipoAbbonamento: string | null;
  sessione: FinestraUtilizzo | null;
  settimana: FinestraUtilizzo | null;
  settimanaOpus: FinestraUtilizzo | null;
}

// Whitelist dei canali IPC (spec §2.3): nessun accesso generico a
// ipcRenderer dal renderer. Gli argomenti sono validati con zod nel main
// process (src/main/pratiche.ts, src/main/claudeIpc.ts) prima di toccare il
// filesystem o di parlare con Claude.
const jarai = {
  version: process.env['npm_package_version'] ?? '0.1.0',
  importaCartella: (): Promise<ImportoCartella | null> => ipcRenderer.invoke('pratiche:importa-cartella'),
  scansionaCartella: (percorso: string): Promise<ImportoCartella> => ipcRenderer.invoke('pratiche:scansiona-cartella', percorso),
  verificaCartelle: (percorsi: string[]): Promise<Record<string, boolean>> => ipcRenderer.invoke('pratiche:verifica-cartelle', percorsi),
  apriNellaCartella: (percorso: string): Promise<void> => ipcRenderer.invoke('pratiche:apri-nella-cartella', percorso),

  claude: {
    verifica: (): Promise<EsitoVerifica> => ipcRenderer.invoke('claude:verifica'),
    statoCollegamentoSalvato: (): Promise<StatoCollegamentoSalvato | null> =>
      ipcRenderer.invoke('claude:stato-collegamento-salvato'),
    salvaChiave: (chiave: string): Promise<void> => ipcRenderer.invoke('claude:salva-chiave', chiave),
    rimuoviChiave: (): Promise<void> => ipcRenderer.invoke('claude:rimuovi-chiave'),
    statoChiave: (): Promise<{ presente: boolean }> => ipcRenderer.invoke('claude:stato-chiave'),
    disconnetti: (): Promise<void> => ipcRenderer.invoke('claude:disconnetti'),
    invia: (payload: InvioPayload): Promise<void> => ipcRenderer.invoke('claude:invia', payload),
    ferma: (conversazioneId: string): Promise<void> => ipcRenderer.invoke('claude:ferma', conversazioneId),
    onEvento: (callback: (evento: EventoAgente) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, evento: EventoAgente) => callback(evento);
      ipcRenderer.on('claude:evento', listener);
      return () => ipcRenderer.removeListener('claude:evento', listener);
    },

    avviaLogin: (modalita: 'console' | 'claudeai'): Promise<void> => ipcRenderer.invoke('claude:avvia-login', modalita),
    inviaCodiceLogin: (codice: string): Promise<void> => ipcRenderer.invoke('claude:invia-codice-login', codice),
    annullaLogin: (): Promise<void> => ipcRenderer.invoke('claude:annulla-login'),
    onEventoLogin: (callback: (evento: EventoLogin) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, evento: EventoLogin) => callback(evento);
      ipcRenderer.on('claude:login-evento', listener);
      return () => ipcRenderer.removeListener('claude:login-evento', listener);
    },

    uso: (): Promise<RiepilogoUso> => ipcRenderer.invoke('claude:uso'),
    usoAbbonamento: (): Promise<UtilizzoAbbonamento | null> => ipcRenderer.invoke('claude:uso-abbonamento'),
  },

  dati: {
    // Il main process valida la forma con zod (src/main/store.ts); qui il
    // bridge resta volutamente non tipizzato, il tipo preciso vive nel
    // renderer (StatoPersistito in src/renderer/src/types.ts).
    carica: (): Promise<unknown> => ipcRenderer.invoke('dati:carica'),
    salva: (stato: unknown): Promise<void> => ipcRenderer.invoke('dati:salva', stato),
  },

  bozze: {
    salvaDocx: (titolo: string, contenuto: string): Promise<{ salvato: boolean; percorso?: string }> =>
      ipcRenderer.invoke('bozze:salva-docx', { titolo, contenuto }),
  },

  audio: {
    stato: (): Promise<{ disponibile: boolean; installazioneAutomaticaDisponibile: boolean }> =>
      ipcRenderer.invoke('audio:stato'),
    installa: (): Promise<{ ok: true } | { ok: false; errore: string }> => ipcRenderer.invoke('audio:installa'),
    onProgresso: (callback: (fase: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, fase: string) => callback(fase);
      ipcRenderer.on('audio:progresso', listener);
      return () => ipcRenderer.removeListener('audio:progresso', listener);
    },
  },
};

contextBridge.exposeInMainWorld('jarai', jarai);

export type JaraiBridge = typeof jarai;
