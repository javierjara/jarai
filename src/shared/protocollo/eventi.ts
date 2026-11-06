import { z } from 'zod';
import {
  articoloSchema,
  bozzaSchema,
  fonteCitataSchema,
  ideaPropostaSchema,
  lavoroDocumentoSchema,
  modalitaSchema,
  passoPianoSchema,
  proceduraSchema,
  qualitaSchema,
} from './modelli';

// Eventi del log (docs/eventstore-protocollo.md §4). L'host è l'unico che li
// crea; i client li ricevono e li applicano con il reducer condiviso.
//
// - seq: numero globale e monotono dell'host. null per gli eventi
//   transitori (testo_delta, lavori), che passano in diretta e non vengono
//   mai scritti nel log.
// - conversazioneId: null per gli eventi che non riguardano una
//   conversazione (entita_cambiata).

const base = {
  seq: z.number().int().positive().nullable(),
  creatoIl: z.string(),
  conversazioneId: z.string().nullable(),
  dispositivoId: z.string().optional(),
  utenteId: z.string().optional(),
};

const evento = <T extends string, P extends z.ZodTypeAny>(tipo: T, payload: P) =>
  z.object({ ...base, tipo: z.literal(tipo), payload });

export const eventoSchema = z.discriminatedUnion('tipo', [
  evento(
    'conversazione_creata',
    z.object({
      modalita: modalitaSchema,
      praticaId: z.string().nullable(),
      titolo: z.string(),
      procedura: proceduraSchema.nullable(),
      qualita: qualitaSchema,
    }),
  ),
  evento('conversazione_rinominata', z.object({ titolo: z.string() })),
  evento('conversazione_eliminata', z.object({})),
  evento('messaggio_utente', z.object({ messaggioId: z.string(), testo: z.string() })),
  evento('turno_iniziato', z.object({ turnoId: z.string(), qualita: qualitaSchema })),
  evento('attivita', z.object({ turnoId: z.string(), testo: z.string() })),
  evento('testo_delta', z.object({ turnoId: z.string(), testo: z.string() })),
  evento('lavori', z.object({ turnoId: z.string(), lavori: z.array(lavoroDocumentoSchema) })),
  evento('piano', z.object({ passi: z.array(passoPianoSchema) })),
  evento(
    'bozza_versione',
    z.object({ turnoId: z.string(), bozzaId: z.string(), numero: z.number().int().positive(), bozza: bozzaSchema }),
  ),
  evento('articolo', z.object({ turnoId: z.string(), articolo: articoloSchema })),
  evento('idee', z.object({ turnoId: z.string(), idee: z.array(ideaPropostaSchema) })),
  evento(
    'testo_assistente',
    z.object({
      turnoId: z.string(),
      messaggioId: z.string(),
      testo: z.string(),
      fonti: z.array(fonteCitataSchema).optional(),
    }),
  ),
  evento(
    'conferma_richiesta',
    z.object({
      confermaId: z.string(),
      turnoId: z.string(),
      livello: z.enum(['conferma', 'revisione']),
      titolo: z.string(),
      anteprima: z.string().optional(),
    }),
  ),
  evento(
    'conferma_risposta',
    z.object({
      confermaId: z.string(),
      esito: z.enum(['approvata', 'modifiche', 'rifiutata']),
      nota: z.string().optional(),
    }),
  ),
  evento(
    'turno_finito',
    z.object({
      turnoId: z.string(),
      esito: z.enum(['ok', 'errore', 'interrotto']),
      costoUsd: z.number().optional(),
      // Solo il messaggio per l'avvocato, già in italiano. Il testo parziale
      // arrivato prima dell'errore lo ricostruisce il reducer: l'host non
      // deve più incollarlo nel messaggio (oggi succede due volte).
      messaggioErrore: z.string().optional(),
      // Testo arrivato in streaming fino all'errore o all'interruzione.
      // Serve perché i testo_delta non sono nel log: senza, chi rilegge il
      // log dopo un riavvio perderebbe la risposta parziale.
      testoParziale: z.string().optional(),
    }),
  ),
  evento(
    'entita_cambiata',
    z.object({
      entita: z.enum(['pratica', 'documento', 'idea', 'preferenze', 'studio', 'conversazione_sito']),
      id: z.string(),
      azione: z.enum(['creata', 'aggiornata', 'eliminata']),
    }),
  ),
]);

export type Evento = z.infer<typeof eventoSchema>;
export type TipoEvento = Evento['tipo'];
export type EventoDi<T extends TipoEvento> = Extract<Evento, { tipo: T }>;

/** Eventi che passano solo in diretta e non vengono scritti nel log. */
export const TIPI_TRANSITORI = ['testo_delta', 'lavori'] as const satisfies readonly TipoEvento[];

export function eTransitorio(tipo: TipoEvento): boolean {
  return (TIPI_TRANSITORI as readonly string[]).includes(tipo);
}
