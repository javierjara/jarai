import { z } from 'zod';
import { comandoSchema, esitoComandoSchema } from './comandi';
import { eventoSchema } from './eventi';

// Una sola busta per tutti i trasporti: IPC di Electron oggi, relay cifrato
// e WebSocket di JarAI Server domani (docs/eventstore-protocollo.md §5.2).

export const VERSIONE_PROTOCOLLO = 1;

export const richiestaSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('snapshot.elenco') }),
  // Pratiche, documenti, impostazioni, idee, articoli. null finché la
  // migrazione dal vecchio JSON non è fatta: il client resta sul JSON.
  z.object({ tipo: z.literal('snapshot.entita') }),
  z.object({ tipo: z.literal('snapshot.conversazione'), conversazioneId: z.string() }),
  z.object({
    tipo: z.literal('eventi.dopo'),
    seq: z.number().int().nonnegative(),
    limite: z.number().int().positive().max(5000).default(1000),
  }),
  z.object({
    tipo: z.literal('abbona'),
    conversazioni: z.union([z.literal('tutte'), z.array(z.string())]),
  }),
]);
export type Richiesta = z.infer<typeof richiestaSchema>;

export const bustaSchema = z.discriminatedUnion('tipo', [
  z.object({ v: z.literal(VERSIONE_PROTOCOLLO), tipo: z.literal('comando'), id: z.string(), comando: comandoSchema }),
  z.object({ v: z.literal(VERSIONE_PROTOCOLLO), tipo: z.literal('richiesta'), id: z.string(), richiesta: richiestaSchema }),
  z.object({
    v: z.literal(VERSIONE_PROTOCOLLO),
    tipo: z.literal('risposta'),
    id: z.string(),
    // Esito di un comando, oppure il risultato di una richiesta: la forma
    // del risultato dipende dalla richiesta e la valida chi l'ha fatta.
    esito: z.union([esitoComandoSchema, z.object({ ok: z.literal(true), dati: z.unknown() })]),
  }),
  z.object({ v: z.literal(VERSIONE_PROTOCOLLO), tipo: z.literal('evento'), evento: eventoSchema }),
]);
export type Busta = z.infer<typeof bustaSchema>;
