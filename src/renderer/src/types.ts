// Vocabolario vincolante (spec §1): questi tipi usano solo i nomi della
// colonna "Nome in JarAI", mai i termini tecnici di T3 Code / Claude Code.

export type MainView = 'home' | 'storico' | 'pratiche' | 'impostazioni';

export type StatoConversazione = 'in_corso' | 'attesa' | 'completata' | 'interrotta';

export const PROCEDURE = [
  'Analisi & Redazione',
  'Cronologia dei fatti',
  'Revisione contratto',
  'Analisi estratti conto e spese',
] as const;
export type Procedura = (typeof PROCEDURE)[number];

export const AMBITI = [
  'Civile',
  'Famiglia',
  'Bancario',
  'Lavoro',
  'Societario',
  'Successioni',
] as const;
export type Ambito = (typeof AMBITI)[number];

export interface Pratica {
  id: string;
  nome: string;
  cliente: string;
  controparte?: string;
  ambito: Ambito;
  note?: string;
  documenti: number;
  aggiornataIl: string;
  cartellaPercorso: string | null;
  cartellaTrovata: boolean;
}

export interface FonteCitata {
  documento: string;
  pagina?: number;
}

export interface Bozza {
  titolo: string;
  contenuto: string;
}

export interface Messaggio {
  id: string;
  ruolo: 'avvocato' | 'assistente';
  testo: string;
  fonti?: FonteCitata[];
  isStreaming?: boolean;
  bozza?: Bozza;
}

export type PassoStato = 'completato' | 'in_corso' | 'in_attesa';

export interface PassoPiano {
  id: string;
  testo: string;
  stato: PassoStato;
}

export interface Conversazione {
  id: string;
  praticaId: string;
  titolo: string;
  procedura: Procedura;
  stato: StatoConversazione;
  aggiornataIl: string;
  dispositivoOrigine?: 'desktop' | 'telefono';
  attivitaCorrente?: string;
  piano?: PassoPiano[];
  messaggi: Messaggio[];
}

export interface Documento {
  id: string;
  nome: string;
  tipo: string;
  pagine?: number;
  data: string;
  cartella: string;
  dimensione?: number;
  percorso?: string;
}

export interface FileImportato {
  nome: string;
  percorso: string;
  cartella: string;
  estensione: string;
  dimensione: number;
  modificatoIl: string;
}

export interface ImportoCartella {
  cartellaPercorso: string;
  cartellaNome: string;
  file: FileImportato[];
}

export interface Studio {
  nome: string;
  avvocato: string;
}

export interface StatoPersistito {
  pratiche: Pratica[];
  documenti: Record<string, Documento[]>;
  conversazioni: Conversazione[];
  studio?: Studio;
}
