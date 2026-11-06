// Vocabolario vincolante (spec §1): questi tipi usano solo i nomi della
// colonna "Nome in JarAI", mai i termini tecnici di T3 Code / Claude Code.

export type MainView = 'home' | 'storico' | 'pratiche' | 'studio-digitale' | 'impostazioni';

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

// Articolo per il sito dello studio proposto dall'assistente (Studio
// digitale) — stessa forma di ArticoloProposto in src/main/sito/strumenti.ts.
export interface Articolo {
  titolo: string;
  slug: string;
  metaTitolo: string;
  metaDescrizione: string;
  categorie: string[];
  contenuto: string;
  fotoCerca?: string;
  /** Punti da controllare prima di pubblicare (date, norme, importi). */
  daVerificare?: string[];
  /** Post LinkedIn che accompagna l'articolo. */
  linkedin?: string;
  /** Carosello Instagram: slide (la prima è la copertina) e didascalia. */
  instagram?: { slide: SlideInstagram[]; didascalia: string };
}

export interface SlideInstagram {
  titoletto: string;
  testo: string;
}

// Idea di articolo (Studio digitale, scheda Idee).
export type TipoIdea = 'google' | 'normativa' | 'stagionale' | 'domande' | 'aggiornamento';
export interface Idea {
  id: string;
  titolo: string;
  categoria: string;
  motivo: string;
  tipo: TipoIdea;
  fonte?: string;
  stato: 'da_valutare' | 'pianificata' | 'scritta' | 'scartata';
  /** Giorno previsto (AAAA-MM-GG) per le idee pianificate. */
  pianificataPer?: string;
  /** Articolo nato dall'idea. */
  conversazioneId?: string;
  creataIl: string;
}

export interface PreferenzeSito {
  ultimeIdeeIl?: string;
  /** Articoli a settimana (obiettivo nel calendario). */
  obiettivoSettimana: number;
}

// Immagine di copertina scelta per l'articolo (src/main/sito/immagini.ts):
// file locale, finché l'invio della bozza non la carica sul sito (mediaId).
export interface Copertina {
  file: string;
  alt: string;
  origine: 'copertina' | 'foto' | 'sito' | 'caricata';
  credito?: string;
  mediaId?: number | string;
}

export interface Messaggio {
  id: string;
  ruolo: 'avvocato' | 'assistente';
  testo: string;
  fonti?: FonteCitata[];
  isStreaming?: boolean;
  bozza?: Bozza;
  articolo?: Articolo;
}

// L'articolo come esiste sul sito: id del post in Payload e stato.
export interface ArticoloSulSito {
  id: number | string;
  stato: 'bozza' | 'pubblicato';
  urlModifica: string;
  urlPubblico: string;
  aggiornatoIl: string;
}

// Una conversazione dello Studio digitale = un articolo: tutte le versioni
// proposte aggiornano lo stesso post sul sito.
export interface ConversazioneSito {
  id: string;
  titolo: string;
  stato: StatoConversazione;
  aggiornataIl: string;
  messaggi: Messaggio[];
  sito?: ArticoloSulSito;
  copertina?: Copertina;
  /** Versione di lavoro dell'articolo: l'ultima proposta, con le modifiche dell'avvocato. */
  articolo?: Articolo;
  /** L'avvocato ha modificato il testo dopo l'ultima proposta dell'assistente. */
  modificato?: boolean;
  /** Ultima modifica di articolo o copertina (per "modifiche non ancora inviate"). */
  modificataIl?: string;
  /** Pubblicazione programmata (ISO): la esegue JarAI (src/main/sito/programmazione.ts). */
  programmataPer?: string;
  ultimoErroreProgrammazione?: string;
  /** Giorno previsto (AAAA-MM-GG) se non ancora programmato. */
  dataPrevista?: string;
  /** Promemoria per i social (ISO): la pubblicazione lì è manuale. */
  social?: { linkedinIl?: string; instagramIl?: string; linkedinFatto?: boolean; instagramFatto?: boolean };
}

export type PassoStato = 'completato' | 'in_corso' | 'in_attesa';

export interface PassoPiano {
  id: string;
  testo: string;
  stato: PassoStato;
}

// Lavoro lungo su un documento (trascrizione audio, OCR di un PDF
// scansionato) — stessa forma di LavoroDocumento in src/main/documentTools.ts.
export interface LavoroDocumento {
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
  /** Solo nei file salvati prima di jarai.db: ora le conversazioni stanno nell'host. */
  conversazioni?: Conversazione[];
  studio?: Studio;
  studioDigitale?: ConversazioneSito[];
  ideeSito?: Idea[];
  preferenzeSito?: PreferenzeSito;
}
