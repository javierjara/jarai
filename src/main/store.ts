import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Persistenza minima locale, in attesa di SQLite (spec §8.2, Fase 5): un
// unico file JSON nella cartella dati dell'app. Stessa forma dei dati del
// renderer, così il passaggio a `jarai.db` più avanti non tocca la UI —
// cambia solo dove FolderService/EventStore leggono e scrivono.
const DATI_PATH = () => join(app.getPath('userData'), 'jarai-dati.json');

const ambitoSchema = z.enum(['Civile', 'Famiglia', 'Bancario', 'Lavoro', 'Societario', 'Successioni']);
const proceduraSchema = z.enum(['Analisi & Redazione', 'Cronologia dei fatti', 'Revisione contratto', 'Analisi estratti conto e spese']);

const praticaSchema = z.object({
  id: z.string(),
  nome: z.string(),
  cliente: z.string(),
  controparte: z.string().optional(),
  ambito: ambitoSchema,
  note: z.string().optional(),
  documenti: z.number(),
  aggiornataIl: z.string(),
  cartellaPercorso: z.string().nullable(),
  cartellaTrovata: z.boolean(),
});

const documentoSchema = z.object({
  id: z.string(),
  nome: z.string(),
  tipo: z.string(),
  pagine: z.number().optional(),
  data: z.string(),
  cartella: z.string(),
  dimensione: z.number().optional(),
  percorso: z.string().optional(),
});

const fonteCitataSchema = z.object({
  documento: z.string(),
  pagina: z.number().optional(),
});

const bozzaSchema = z.object({
  titolo: z.string(),
  contenuto: z.string(),
});

const articoloSchema = z.object({
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

const ideaSchema = z.object({
  id: z.string(),
  titolo: z.string(),
  categoria: z.string(),
  motivo: z.string(),
  tipo: z.enum(['google', 'normativa', 'stagionale', 'domande', 'aggiornamento']),
  fonte: z.string().optional(),
  stato: z.enum(['da_valutare', 'pianificata', 'scritta', 'scartata']),
  pianificataPer: z.string().optional(),
  conversazioneId: z.string().optional(),
  creataIl: z.string(),
});

const preferenzeSitoSchema = z.object({
  ideeLunedi: z.boolean(),
  ultimeIdeeIl: z.string().optional(),
  obiettivoSettimana: z.number(),
});

const copertinaSchema = z.object({
  file: z.string(),
  alt: z.string(),
  origine: z.enum(['copertina', 'foto', 'sito', 'caricata']),
  credito: z.string().optional(),
  mediaId: z.union([z.number(), z.string()]).optional(),
});

const messaggioSchema = z.object({
  id: z.string(),
  ruolo: z.enum(['avvocato', 'assistente']),
  testo: z.string(),
  fonti: z.array(fonteCitataSchema).optional(),
  isStreaming: z.boolean().optional(),
  bozza: bozzaSchema.optional(),
  articolo: articoloSchema.optional(),
});

const passoPianoSchema = z.object({
  id: z.string(),
  testo: z.string(),
  stato: z.enum(['completato', 'in_corso', 'in_attesa']),
});

const conversazioneSchema = z.object({
  id: z.string(),
  praticaId: z.string(),
  titolo: z.string(),
  procedura: proceduraSchema,
  stato: z.enum(['in_corso', 'attesa', 'completata', 'interrotta']),
  aggiornataIl: z.string(),
  dispositivoOrigine: z.enum(['desktop', 'telefono']).optional(),
  attivitaCorrente: z.string().optional(),
  piano: z.array(passoPianoSchema).optional(),
  messaggi: z.array(messaggioSchema),
});

const studioSchema = z.object({ nome: z.string(), avvocato: z.string() });

const conversazioneSitoSchema = z.object({
  id: z.string(),
  titolo: z.string(),
  stato: z.enum(['in_corso', 'attesa', 'completata', 'interrotta']),
  aggiornataIl: z.string(),
  messaggi: z.array(messaggioSchema),
  sito: z
    .object({
      id: z.union([z.number(), z.string()]),
      stato: z.enum(['bozza', 'pubblicato']),
      urlModifica: z.string(),
      urlPubblico: z.string(),
      aggiornatoIl: z.string(),
    })
    .optional(),
  copertina: copertinaSchema.optional(),
  articolo: articoloSchema.optional(),
  modificato: z.boolean().optional(),
  modificataIl: z.string().optional(),
  programmataPer: z.string().optional(),
  ultimoErroreProgrammazione: z.string().optional(),
  dataPrevista: z.string().optional(),
  social: z
    .object({
      linkedinIl: z.string().optional(),
      instagramIl: z.string().optional(),
      linkedinFatto: z.boolean().optional(),
      instagramFatto: z.boolean().optional(),
    })
    .optional(),
});

const statoSchema = z.object({
  pratiche: z.array(praticaSchema),
  documenti: z.record(z.string(), z.array(documentoSchema)),
  conversazioni: z.array(conversazioneSchema),
  // Facoltativo: i dati salvati prima di questo campo (jarai-dati.json già
  // esistenti) restano validi, l'app riparte dal nome studio di default.
  studio: studioSchema.optional(),
  // Studio digitale: facoltativo come sopra.
  studioDigitale: z.array(conversazioneSitoSchema).optional(),
  ideeSito: z.array(ideaSchema).optional(),
  preferenzeSito: preferenzeSitoSchema.optional(),
});

export type StatoPersistito = z.infer<typeof statoSchema>;

export async function caricaDati(): Promise<StatoPersistito | null> {
  try {
    const testo = await fs.readFile(DATI_PATH(), 'utf-8');
    const risultato = statoSchema.safeParse(JSON.parse(testo));
    return risultato.success ? risultato.data : null;
  } catch {
    return null; // Primo avvio, o file assente/corrotto: si riparte dai dati d'esempio.
  }
}

async function salvaDati(stato: StatoPersistito): Promise<void> {
  await fs.writeFile(DATI_PATH(), JSON.stringify(stato, null, 2), 'utf-8');
}

export function registraPersistenza(): void {
  ipcMain.handle('dati:carica', async () => caricaDati());

  ipcMain.handle('dati:salva', async (_event, statoInput: unknown) => {
    const stato = statoSchema.parse(statoInput);
    await salvaDati(stato);
  });
}
