import { z } from 'zod';

// Oggetti di dominio che viaggiano dentro eventi e comandi. Stessa forma dei
// tipi del renderer (src/renderer/src/types.ts) e degli strumenti del main:
// qui vivono gli schemi, perché src/shared non può importare né da Electron
// né dal renderer (deve girare uguale su desktop, telefono e JarAI Server).

export const qualitaSchema = z.enum(['Standard', 'Massima']);
export const modalitaSchema = z.enum(['pratica', 'studio-digitale']);
export const proceduraSchema = z.enum([
  'Analisi & Redazione',
  'Cronologia dei fatti',
  'Revisione contratto',
  'Analisi estratti conto e spese',
]);
export const statoConversazioneSchema = z.enum(['in_corso', 'attesa', 'completata', 'interrotta']);

export const fonteCitataSchema = z.object({
  documento: z.string(),
  pagina: z.number().optional(),
});

export const bozzaSchema = z.object({
  titolo: z.string(),
  contenuto: z.string(),
});

export const articoloSchema = z.object({
  titolo: z.string(),
  slug: z.string(),
  metaTitolo: z.string(),
  metaDescrizione: z.string(),
  categorie: z.array(z.string()),
  contenuto: z.string(),
  fotoCerca: z.string().optional(),
  daVerificare: z.array(z.string()).optional(),
  linkedin: z.string().optional(),
  instagram: z
    .object({ slide: z.array(z.object({ titoletto: z.string(), testo: z.string() })), didascalia: z.string() })
    .optional(),
});

export const ideaPropostaSchema = z.object({
  titolo: z.string(),
  categoria: z.string(),
  motivo: z.string(),
  tipo: z.enum(['google', 'normativa', 'stagionale', 'domande', 'aggiornamento']),
  fonte: z.string().optional(),
});

export const passoPianoSchema = z.object({
  id: z.string(),
  testo: z.string(),
  stato: z.enum(['completato', 'in_corso', 'in_attesa']),
});

export const lavoroDocumentoSchema = z.object({
  id: z.string(),
  nome: z.string(),
  tipo: z.enum(['trascrizione', 'ocr']),
  fase: z.enum(['in-coda', 'preparazione', 'modello', 'trascrizione', 'ocr', 'completato']),
  progresso: z.number().optional(),
  durataSec: z.number().optional(),
  iniziatoIl: z.number().optional(),
  pagina: z.number().optional(),
  pagineTotali: z.number().optional(),
});

export type Qualita = z.infer<typeof qualitaSchema>;
export type Modalita = z.infer<typeof modalitaSchema>;
export type Procedura = z.infer<typeof proceduraSchema>;
export type StatoConversazione = z.infer<typeof statoConversazioneSchema>;
export type FonteCitata = z.infer<typeof fonteCitataSchema>;
export type Bozza = z.infer<typeof bozzaSchema>;
export type Articolo = z.infer<typeof articoloSchema>;
export type IdeaProposta = z.infer<typeof ideaPropostaSchema>;
export type PassoPiano = z.infer<typeof passoPianoSchema>;
export type LavoroDocumento = z.infer<typeof lavoroDocumentoSchema>;

// ─── Entità (passo 5): pratiche, documenti, impostazioni, Studio digitale ──

export const ambitoSchema = z.enum(['Civile', 'Famiglia', 'Bancario', 'Lavoro', 'Societario', 'Successioni']);

export const praticaSchema = z.object({
  id: z.string().min(1),
  nome: z.string(),
  cliente: z.string(),
  controparte: z.string().optional(),
  ambito: ambitoSchema,
  note: z.string().optional(),
  documenti: z.number().int().nonnegative(),
  aggiornataIl: z.string(),
  cartellaPercorso: z.string().nullable(),
});

export const documentoSchema = z.object({
  id: z.string().min(1),
  nome: z.string(),
  tipo: z.string(),
  pagine: z.number().optional(),
  data: z.string(),
  cartella: z.string(),
  dimensione: z.number().optional(),
  percorso: z.string().optional(),
});

export const studioSchema = z.object({ nome: z.string(), avvocato: z.string() });

// Forme che cambiano spesso con lo Studio digitale: si validano solo i
// campi su cui si appoggia l'host, il resto passa così com'è.
export const preferenzeSitoSchema = z.looseObject({ obiettivoSettimana: z.number() });
export const ideaSchema = z.looseObject({ id: z.string().min(1) });
/** Dati editoriali di un articolo: tutto tranne messaggi e stato, che sono dell'host. */
export const datiConversazioneSitoSchema = z.looseObject({ id: z.string().min(1), titolo: z.string() });

export type Pratica = z.infer<typeof praticaSchema>;
export type Documento = z.infer<typeof documentoSchema>;
export type Studio = z.infer<typeof studioSchema>;
export type DatiConversazioneSito = z.infer<typeof datiConversazioneSitoSchema>;
