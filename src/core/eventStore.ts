import { eTransitorio, eventoSchema, type Evento } from '../shared/protocollo';
import { inTransazione, type Database } from './db';

// EventStore (docs/eventstore-protocollo.md §3): log append-only di jarai.db.
// L'host è l'unico a scriverci. Gli eventi transitori (testo_delta, lavori)
// non passano di qui: vanno direttamente agli abbonati.

type OmitDistributivo<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Evento da scrivere: seq lo assegna il database, creatoIl l'orologio dell'host se manca. */
export type EventoNuovo = OmitDistributivo<Evento, 'seq' | 'creatoIl'> & { creatoIl?: string };

export interface EsitoAppendi {
  eventi: Evento[];
  /** true se il comando era già stato eseguito: gli eventi sono quelli di allora. */
  giaEseguito: boolean;
}

interface RigaEvento {
  seq: number;
  conversazione_id: string | null;
  tipo: string;
  payload: string;
  utente_id: string | null;
  dispositivo_id: string | null;
  creato_il: string;
}

const COLONNE = 'seq, conversazione_id, tipo, payload, utente_id, dispositivo_id, creato_il';

export class EventStore {
  private readonly inserisci;
  private readonly leggiComando;
  private readonly registraComando;
  private readonly leggiIntervallo;
  private readonly leggiDopo;
  private readonly leggiConversazione;
  private readonly leggiUltimo;

  constructor(
    private readonly db: Database,
    private readonly orologio: () => string = () => new Date().toISOString(),
  ) {
    this.inserisci = db.prepare(
      `INSERT INTO evento (conversazione_id, tipo, payload, utente_id, dispositivo_id, comando_id, creato_il)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.leggiComando = db.prepare('SELECT primo_seq, ultimo_seq FROM comando WHERE id = ?');
    this.registraComando = db.prepare('INSERT INTO comando (id, primo_seq, ultimo_seq, eseguito_il) VALUES (?, ?, ?, ?)');
    this.leggiIntervallo = db.prepare(`SELECT ${COLONNE} FROM evento WHERE seq BETWEEN ? AND ? ORDER BY seq`);
    this.leggiDopo = db.prepare(`SELECT ${COLONNE} FROM evento WHERE seq > ? ORDER BY seq LIMIT ?`);
    this.leggiConversazione = db.prepare(`SELECT ${COLONNE} FROM evento WHERE conversazione_id = ? ORDER BY seq`);
    this.leggiUltimo = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM evento');
  }

  /**
   * Scrive gli eventi in una sola transazione: o tutti o nessuno.
   * Con comandoId, un comando già eseguito restituisce gli eventi di allora.
   */
  appendi(eventi: readonly EventoNuovo[], opzioni: { comandoId?: string } = {}): EsitoAppendi {
    const { comandoId } = opzioni;
    return inTransazione(this.db, () => {
      if (comandoId) {
        const fatto = this.leggiComando.get(comandoId) as { primo_seq: number | null; ultimo_seq: number | null } | undefined;
        if (fatto) {
          const vecchi =
            fatto.primo_seq === null
              ? []
              : (this.leggiIntervallo.all(fatto.primo_seq, fatto.ultimo_seq) as unknown as RigaEvento[]).map(daRiga);
          return { eventi: vecchi, giaEseguito: true };
        }
      }

      const scritti: Evento[] = [];
      for (const nuovo of eventi) {
        if (eTransitorio(nuovo.tipo)) {
          throw new Error(`L'evento "${nuovo.tipo}" è transitorio e non va scritto nel log.`);
        }
        const creatoIl = nuovo.creatoIl ?? this.orologio();
        // Validazione prima della scrittura: nel log entra solo ciò che il
        // protocollo conosce. seq provvisorio, lo sostituisce il database.
        const valido = eventoSchema.parse({ ...nuovo, seq: 1, creatoIl });
        const r = this.inserisci.run(
          valido.conversazioneId,
          valido.tipo,
          JSON.stringify(valido.payload),
          valido.utenteId ?? null,
          valido.dispositivoId ?? null,
          comandoId ?? null,
          creatoIl,
        );
        scritti.push({ ...valido, seq: Number(r.lastInsertRowid) });
      }

      if (comandoId) {
        this.registraComando.run(comandoId, scritti[0]?.seq ?? null, scritti.at(-1)?.seq ?? null, this.orologio());
      }
      return { eventi: scritti, giaEseguito: false };
    });
  }

  comandoEseguito(comandoId: string): boolean {
    return this.leggiComando.get(comandoId) !== undefined;
  }

  /** Eventi dopo un cursore, per la riconnessione di un client. */
  dopo(seq: number, limite = 1000): Evento[] {
    return (this.leggiDopo.all(seq, limite) as unknown as RigaEvento[]).map(daRiga);
  }

  perConversazione(conversazioneId: string): Evento[] {
    return (this.leggiConversazione.all(conversazioneId) as unknown as RigaEvento[]).map(daRiga);
  }

  ultimoSeq(): number {
    return (this.leggiUltimo.get() as { seq: number }).seq;
  }
}

function daRiga(r: RigaEvento): Evento {
  // Nessuna validazione in lettura: nel log scrive solo appendi(), che valida.
  return {
    seq: r.seq,
    creatoIl: r.creato_il,
    conversazioneId: r.conversazione_id,
    ...(r.utente_id ? { utenteId: r.utente_id } : {}),
    ...(r.dispositivo_id ? { dispositivoId: r.dispositivo_id } : {}),
    tipo: r.tipo,
    payload: JSON.parse(r.payload),
  } as Evento;
}
