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
  modalita?: 'chiave' | 'account' | 'licenza';
  messaggio?: string;
}

interface StatoLicenza {
  valida: boolean;
  messaggio?: string;
  studio?: string;
  piano?: string;
  domandeUsate?: number;
  domandeMese?: number;
}

interface StatoCollegamentoSalvato extends EsitoVerifica {
  verificatoIl: string;
}

interface InvioPayload {
  conversazioneId: string;
  testo: string;
  qualita: 'Standard' | 'Massima';
  praticaId?: string;
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
  | { tipo: 'bozza'; conversazioneId: string; titolo: string; contenuto: string }
  | { tipo: 'lavori'; conversazioneId: string; lavori: LavoroDocumento[] };

// Stessa forma di AvanzamentoTrascrizione in src/main/trascrizione.ts.
interface AvanzamentoTrascrizione {
  fase: 'in-coda' | 'preparazione' | 'modello' | 'trascrizione';
  progresso?: number;
  durataSec?: number;
}

interface EventoTrascrizione {
  percorso: string;
  avanzamento: AvanzamentoTrascrizione;
}

interface EsitoTrascrizione {
  testo: string;
  percorso: string;
  nome: string;
  dimensione: number;
  modificatoIl: string;
}

// Stessa forma di LavoroDocumento in src/main/documentTools.ts.
interface LavoroDocumento {
  id: string;
  nome: string;
  tipo: 'trascrizione' | 'ocr';
  fase: 'in-coda' | 'preparazione' | 'modello' | 'trascrizione' | 'ocr' | 'completato';
  progresso?: number;
  durataSec?: number;
  iniziatoIl?: number;
  pagina?: number;
  pagineTotali?: number;
}

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

interface StatoIndicizzazione {
  totale: number;
  completati: number;
  corrente: string | null;
}

// Stessa forma di StatoDejure in src/main/dejure.ts.
interface StatoDejure {
  attiva: boolean;
  utente?: string;
  avvertenzaAccettataIl?: string;
}

type EventoAggiornamento =
  | { tipo: 'controllo' }
  | { tipo: 'disponibile'; versione: string }
  | { tipo: 'non-disponibile' }
  | { tipo: 'progresso'; percentuale: number }
  | { tipo: 'scaricato'; versione: string }
  | { tipo: 'errore'; messaggio: string };

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
  apriConAppPredefinita: (percorso: string): Promise<void> => ipcRenderer.invoke('pratiche:apri-con-app-predefinita', percorso),
  eliminaMemoria: (praticaId: string): Promise<void> => ipcRenderer.invoke('pratiche:elimina-memoria', praticaId),

  documenti: {
    anteprimaPdf: (percorso: string, pagina: number): Promise<{ dati: Uint8Array; larghezza: number; altezza: number; totalePagine: number }> =>
      ipcRenderer.invoke('documenti:anteprima-pdf', { percorso, pagina }),
    anteprimaImmagine: (percorso: string): Promise<{ dati: Uint8Array; mime: string }> =>
      ipcRenderer.invoke('documenti:anteprima-immagine', percorso),
    anteprimaDocx: (percorso: string): Promise<{ testo: string }> => ipcRenderer.invoke('documenti:anteprima-docx', percorso),
  },

  claude: {
    verifica: (): Promise<EsitoVerifica> => ipcRenderer.invoke('claude:verifica'),
    statoCollegamentoSalvato: (): Promise<StatoCollegamentoSalvato | null> =>
      ipcRenderer.invoke('claude:stato-collegamento-salvato'),
    salvaChiave: (chiave: string): Promise<void> => ipcRenderer.invoke('claude:salva-chiave', chiave),
    rimuoviChiave: (): Promise<void> => ipcRenderer.invoke('claude:rimuovi-chiave'),
    statoChiave: (): Promise<{ presente: boolean }> => ipcRenderer.invoke('claude:stato-chiave'),
    disconnetti: (): Promise<void> => ipcRenderer.invoke('claude:disconnetti'),
    attivaLicenza: (licenza: string): Promise<StatoLicenza> => ipcRenderer.invoke('claude:attiva-licenza', licenza),
    statoLicenza: (): Promise<StatoLicenza> => ipcRenderer.invoke('claude:stato-licenza'),
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
    salvaPdf: (titolo: string, contenuto: string): Promise<{ salvato: boolean; percorso?: string }> =>
      ipcRenderer.invoke('bozze:salva-pdf', { titolo, contenuto }),
  },

  trascrizione: {
    avvia: (percorso: string, cartellaPratica: string, nomeFile: string): Promise<EsitoTrascrizione> =>
      ipcRenderer.invoke('trascrizione:avvia', { percorso, cartellaPratica, nomeFile }),
    onEvento: (callback: (evento: EventoTrascrizione) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, evento: EventoTrascrizione) => callback(evento);
      ipcRenderer.on('trascrizione:evento', listener);
      return () => ipcRenderer.removeListener('trascrizione:evento', listener);
    },
  },

  // Indice dei documenti in background (src/main/indice.ts): solo lettura
  // dell'avanzamento, l'indicizzazione la avvia il main da solo.
  indice: {
    onEvento: (callback: (stato: StatoIndicizzazione) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, stato: StatoIndicizzazione) => callback(stato);
      ipcRenderer.on('indice:evento', listener);
      return () => ipcRenderer.removeListener('indice:evento', listener);
    },
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

  // Integrazione DeJure (src/main/dejure.ts): la password passa una sola
  // volta, al collegamento, e da lì resta cifrata nel main process.
  dejure: {
    stato: (): Promise<StatoDejure> => ipcRenderer.invoke('dejure:stato'),
    collega: (utente: string, password: string): Promise<{ ok: true; stato: StatoDejure } | { ok: false; errore: string }> =>
      ipcRenderer.invoke('dejure:collega', { utente, password, avvertenzaAccettata: true }),
    scollega: (): Promise<void> => ipcRenderer.invoke('dejure:scollega'),
  },

  aggiornamenti: {
    controlla: (): Promise<void> => ipcRenderer.invoke('aggiornamenti:controlla'),
    scarica: (): Promise<void> => ipcRenderer.invoke('aggiornamenti:scarica'),
    installa: (): Promise<void> => ipcRenderer.invoke('aggiornamenti:installa'),
    onEvento: (callback: (evento: EventoAggiornamento) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, evento: EventoAggiornamento) => callback(evento);
      ipcRenderer.on('aggiornamenti:evento', listener);
      return () => ipcRenderer.removeListener('aggiornamenti:evento', listener);
    },
  },
};

contextBridge.exposeInMainWorld('jarai', jarai);

export type JaraiBridge = typeof jarai;
