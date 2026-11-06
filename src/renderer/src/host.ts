import { useEffect, useSyncExternalStore } from 'react';
import type { SnapshotEntita } from '../../shared/entita';
import type { Comando, EsitoComando, Evento, Richiesta } from '../../shared/protocollo';
import {
  ELENCO_VUOTO,
  riduciConversazione,
  riduciElenco,
  type ProiezioneConversazione,
  type ProiezioneElenco,
} from '../../shared/reducer';

// Client dell'host per la finestra (docs/eventstore-protocollo.md §5.1).
// La finestra non possiede più le conversazioni: manda comandi e disegna le
// proiezioni, aggiornate con lo stesso reducer che usa l'host. Lo stesso
// schema servirà al telefono, con un altro trasporto.
//
// Ordine garantito: l'IPC di Electron consegna risposte ed eventi nell'ordine
// in cui il main li manda. Gli eventi arrivati mentre si aspetta uno
// snapshot sono già compresi nello snapshot, quindi si scartano.

type SenzaComandoId<T> = T extends unknown ? Omit<T, 'comandoId'> : never;

const nuovoId = () => crypto.randomUUID();
const MESSAGGIO_GENERICO = 'JarAI non ha risposto. Riprova tra un momento.';

async function inviaBusta(contenuto: { tipo: 'comando'; comando: Comando } | { tipo: 'richiesta'; richiesta: Richiesta }) {
  const risposta = await window.jarai.host.busta({ v: 1, id: nuovoId(), ...contenuto });
  if (risposta.tipo !== 'risposta') throw new Error(MESSAGGIO_GENERICO);
  return risposta.esito;
}

/** Manda un comando all'host. Il comandoId lo genera qui: se si rimanda, non si ripete. */
export async function comando(c: SenzaComandoId<Comando>): Promise<EsitoComando> {
  try {
    const esito = await inviaBusta({ tipo: 'comando', comando: { ...c, comandoId: nuovoId() } as Comando });
    return 'dati' in esito ? { ok: false, errore: MESSAGGIO_GENERICO } : esito;
  } catch {
    return { ok: false, errore: MESSAGGIO_GENERICO };
  }
}

async function richiesta<T>(r: Richiesta): Promise<T> {
  const esito = await inviaBusta({ tipo: 'richiesta', richiesta: r });
  if (!esito.ok || !('dati' in esito)) throw new Error(esito.ok ? MESSAGGIO_GENERICO : esito.errore);
  return esito.dati as T;
}

/** Pratiche, documenti, impostazioni e articoli; null se l'host non li ha ancora (si resta sul JSON). */
export async function caricaEntita(): Promise<SnapshotEntita | null> {
  try {
    return (await richiesta<{ entita: SnapshotEntita | null }>({ tipo: 'snapshot.entita' })).entita;
  } catch {
    return null;
  }
}

class ClienteHost {
  elenco: ProiezioneElenco = ELENCO_VUOTO;
  private elencoPronto = false;
  // undefined: in caricamento; null: non esiste (ancora).
  private readonly conversazioni = new Map<string, ProiezioneConversazione | null>();
  private readonly inCaricamento = new Set<string>();
  private readonly ascoltatori = new Set<() => void>();
  private avviato = false;

  avvia(): void {
    if (this.avviato) return;
    this.avviato = true;
    window.jarai.host.onEvento((e) => this.applica(e));
    void richiesta<{ elenco: ProiezioneElenco }>({ tipo: 'snapshot.elenco' }).then(({ elenco }) => {
      this.elenco = elenco;
      this.elencoPronto = true;
      this.notifica();
    });
  }

  conversazione(id: string): ProiezioneConversazione | null | undefined {
    if (!this.conversazioni.has(id) && !this.inCaricamento.has(id)) this.carica(id);
    return this.conversazioni.get(id);
  }

  private carica(id: string): void {
    this.inCaricamento.add(id);
    void richiesta<{ conversazione: ProiezioneConversazione | null }>({ tipo: 'snapshot.conversazione', conversazioneId: id })
      .then(({ conversazione }) => this.conversazioni.set(id, conversazione))
      .catch(() => this.conversazioni.set(id, null))
      .finally(() => {
        this.inCaricamento.delete(id);
        this.notifica();
      });
  }

  private applica(e: Evento): void {
    let cambiato = false;
    if (this.elencoPronto) {
      const nuovo = riduciElenco(this.elenco, e);
      if (nuovo !== this.elenco) {
        this.elenco = nuovo;
        cambiato = true;
      }
    }
    const id = e.conversazioneId;
    if (id && this.conversazioni.has(id) && !this.inCaricamento.has(id)) {
      const prima = this.conversazioni.get(id) ?? null;
      const dopo = riduciConversazione(prima, e);
      if (dopo !== prima) {
        this.conversazioni.set(id, dopo?.eliminata ? null : dopo);
        cambiato = true;
      }
    }
    if (cambiato) this.notifica();
  }

  iscrivi = (fn: () => void): (() => void) => {
    this.ascoltatori.add(fn);
    return () => this.ascoltatori.delete(fn);
  };

  private notifica(): void {
    for (const fn of this.ascoltatori) fn();
  }
}

export const clienteHost = new ClienteHost();

/** Elenco di tutte le conversazioni, sempre aggiornato. */
export function useElenco(): ProiezioneElenco {
  useEffect(() => clienteHost.avvia(), []);
  return useSyncExternalStore(clienteHost.iscrivi, () => clienteHost.elenco);
}

/** Una conversazione: undefined mentre si carica, null se non esiste ancora. */
export function useConversazione(id: string): ProiezioneConversazione | null | undefined {
  useEffect(() => clienteHost.avvia(), []);
  return useSyncExternalStore(clienteHost.iscrivi, () => clienteHost.conversazione(id));
}
