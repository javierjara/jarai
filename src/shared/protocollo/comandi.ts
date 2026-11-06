import { z } from 'zod';
import { modalitaSchema, proceduraSchema, qualitaSchema } from './modelli';

// Comandi dai client all'host (docs/eventstore-protocollo.md §5). Ogni
// comando porta un comandoId generato dal client: se la connessione cade e
// il client lo rimanda, l'host non lo esegue due volte.

const comando = <T extends string, A extends z.ZodTypeAny>(tipo: T, argomenti: A) =>
  z.object({ comandoId: z.string().min(1), tipo: z.literal(tipo), argomenti });

export const comandoSchema = z.discriminatedUnion('tipo', [
  comando(
    'conversazione.crea',
    z.object({
      conversazioneId: z.string(),
      modalita: modalitaSchema,
      praticaId: z.string().nullable(),
      titolo: z.string(),
      procedura: proceduraSchema.nullable(),
      qualita: qualitaSchema,
    }),
  ),
  comando(
    'conversazione.invia',
    z.object({
      conversazioneId: z.string(),
      // Testo mostrato nella conversazione.
      testo: z.string().min(1),
      // Testo mandato all'assistente, se diverso (Studio digitale: include
      // l'articolo modificato a mano dall'avvocato).
      testoAgente: z.string().optional(),
      qualita: qualitaSchema,
    }),
  ),
  comando('conversazione.ferma', z.object({ conversazioneId: z.string() })),
  comando('conversazione.rinomina', z.object({ conversazioneId: z.string(), titolo: z.string().min(1) })),
  comando('conversazione.elimina', z.object({ conversazioneId: z.string() })),
  comando(
    'conversazione.rispondiConferma',
    z.object({
      conversazioneId: z.string(),
      confermaId: z.string(),
      esito: z.enum(['approvata', 'modifiche', 'rifiutata']),
      nota: z.string().optional(),
    }),
  ),
]);

export type Comando = z.infer<typeof comandoSchema>;
export type TipoComando = Comando['tipo'];

export const esitoComandoSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), seq: z.number().int().nonnegative() }),
  // Messaggio per l'avvocato, in italiano e mai tecnico.
  z.object({ ok: z.literal(false), errore: z.string() }),
]);
export type EsitoComando = z.infer<typeof esitoComandoSchema>;
