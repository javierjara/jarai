import {
  VERSIONE_PROTOCOLLO,
  type Busta,
  type Comando,
  type EsitoComando,
  type Evento,
  type Richiesta,
} from './protocollo';
import { casuale } from './cifratura';
import { ELENCO_VUOTO, riduciConversazione, riduciElenco, type ProiezioneConversazione, type ProiezioneElenco } from './reducer';

// Client remoto dell'host (passo 6 e poi telefono): canale, cursore,
// riconnessione. Usa solo API standard (WebSocket, WebCrypto), quindi gira
// uguale in Node 22+ (test, strumenti), nel browser e in React Native.
//
// Regola d'ordine: mentre aspetta uno snapshot o il recupero dopo una
// riconnessione, il client mette da parte gli eventi in diretta e li
// applica dopo. Il reducer scarta quelli già compresi (seq già visto).

type SenzaComandoId<T> = T extends unknown ? Omit<T, 'comandoId'> : never;

/**
 * La strada verso l'host: un WebSocket diretto (JarAI Server, prove) o il
 * relay cifrato (telefono, src/shared/relay.ts). Il client vede solo testo.
 */
export interface Canale {
  onapri?: () => void;
  onmessaggio?: (testo: string) => void;
  onchiuso?: (codice: number) => void;
  aperto(): boolean;
  invia(testo: string): void;
  chiudi(): void;
}

export function canaleWebSocket(url: string): Canale {
  const ws = new WebSocket(url);
  const c: Canale = {
    aperto: () => ws.readyState === WebSocket.OPEN,
    invia: (t) => ws.send(t),
    chiudi: () => ws.close(),
  };
  ws.onopen = () => c.onapri?.();
  ws.onmessage = (m) => c.onmessaggio?.(String(m.data));
  ws.onclose = (e) => c.onchiuso?.(e.code);
  return c;
}

/** Codici di chiusura condivisi da trasportoWs, relay e canale cifrato. */
export const CHIUSURA = {
  nonAutorizzato: 4401,
  revocato: 4403,
  /** Relay raggiunto, ma il computer è spento o scollegato: si riprova. */
  hostAssente: 4000,
} as const;

export interface OpzioniClienteRemoto {
  /** Es. ws://127.0.0.1:8787/?token=... (in alternativa a canale). */
  url?: string;
  /** Apre una nuova strada a ogni (ri)connessione. */
  canale?: () => Canale;
  onCambio?: () => void;
  /** Ritardo massimo tra due tentativi di riconnessione. */
  attesaMassimaMs?: number;
  /** Oltre questo numero di eventi persi si riparte da uno snapshot. */
  recuperoMassimo?: number;
}

// crypto.randomUUID non c'è in React Native.
const nuovoId = () => casuale(16);

export class ClienteRemoto {
  elenco: ProiezioneElenco = ELENCO_VUOTO;
  connesso = false;
  /** Perché non è collegato, da mostrare (null se collegato o mai provato). */
  motivo: string | null = null;
  private ws: Canale | null = null;
  private chiuso = false;
  private tentativi = 0;
  private sincronizzato = false;
  private inAttesa: Evento[] = [];
  private readonly risposte = new Map<string, (b: Busta) => void>();
  private readonly conversazioni = new Map<string, ProiezioneConversazione | null>();
  private readonly inCaricamento = new Set<string>();

  constructor(private readonly opzioni: OpzioniClienteRemoto) {}

  /** Si collega e si sincronizza; poi resta collegato (con riconnessione) fino a chiudi(). */
  connetti(): Promise<void> {
    this.chiuso = false;
    return new Promise((risolvi, rifiuta) => {
      const { canale, url } = this.opzioni;
      if (!canale && !url) throw new Error('ClienteRemoto: serve url o canale.');
      const ws = canale ? canale() : canaleWebSocket(url!);
      this.ws = ws;
      let aperto = false;
      ws.onapri = () => {
        aperto = true;
        this.connesso = true;
        this.motivo = null;
        this.tentativi = 0;
        this.sincronizza().then(risolvi, rifiuta);
      };
      ws.onmessaggio = (testo) => {
        let b: Busta;
        try {
          b = JSON.parse(testo) as Busta;
        } catch {
          return;
        }
        this.ricevi(b);
      };
      ws.onchiuso = (codice) => {
        if (this.ws !== ws) return;
        this.connesso = false;
        this.sincronizzato = false;
        // Rifiutato (token non valido, dispositivo revocato): definitivo,
        // riprovare non servirebbe.
        const definitivo = codice === CHIUSURA.nonAutorizzato || codice === CHIUSURA.revocato;
        if (definitivo) this.chiuso = true;
        const motivo =
          codice === CHIUSURA.nonAutorizzato
            ? 'Non autorizzato.'
            : codice === CHIUSURA.revocato
              ? 'Questo dispositivo è stato scollegato dal computer.'
              : codice === CHIUSURA.hostAssente
                ? 'Il computer dello studio è spento o non collegato.'
                : aperto
                  ? 'Collegamento interrotto.'
                  : 'Host non raggiungibile.';
        this.motivo = motivo;
        for (const fine of this.risposte.values()) fine(rispostaErrore(motivo));
        this.risposte.clear();
        this.notifica();
        if (!aperto || definitivo) rifiuta(new Error(motivo));
        else if (!this.chiuso) this.riprova();
      };
    });
  }

  chiudi(): void {
    this.chiuso = true;
    this.ws?.chiudi();
  }

  /** Solo per le prove: la rete cade, il client si ricollega da solo. */
  simulaCaduta(): void {
    this.ws?.chiudi();
  }

  async comando(c: SenzaComandoId<Comando>): Promise<EsitoComando> {
    const r = await this.invia({ v: VERSIONE_PROTOCOLLO, tipo: 'comando', id: nuovoId(), comando: { ...c, comandoId: nuovoId() } as Comando });
    return r.tipo === 'risposta' && !('dati' in r.esito) ? r.esito : { ok: false, errore: 'Risposta non valida.' };
  }

  async richiesta<T>(richiesta: Richiesta): Promise<T> {
    const r = await this.invia({ v: VERSIONE_PROTOCOLLO, tipo: 'richiesta', id: nuovoId(), richiesta });
    if (r.tipo !== 'risposta' || !r.esito.ok || !('dati' in r.esito)) {
      throw new Error(r.tipo === 'risposta' && !r.esito.ok ? r.esito.errore : 'Risposta non valida.');
    }
    return r.esito.dati as T;
  }

  /** undefined mentre si carica; null se non esiste. Dopo il primo accesso resta aggiornata. */
  conversazione(id: string): ProiezioneConversazione | null | undefined {
    if (!this.conversazioni.has(id) && !this.inCaricamento.has(id) && this.connesso) void this.carica(id);
    return this.conversazioni.get(id);
  }

  async caricaConversazione(id: string): Promise<ProiezioneConversazione | null> {
    await this.carica(id);
    return this.conversazioni.get(id) ?? null;
  }

  // ─── Interni ──────────────────────────────────────────────────────────

  private async carica(id: string): Promise<void> {
    this.inCaricamento.add(id);
    try {
      const { conversazione } = await this.richiesta<{ conversazione: ProiezioneConversazione | null }>({
        tipo: 'snapshot.conversazione',
        conversazioneId: id,
      });
      this.conversazioni.set(id, conversazione);
    } finally {
      this.inCaricamento.delete(id);
      this.notifica();
    }
  }

  private async sincronizza(): Promise<void> {
    this.sincronizzato = false;
    this.inAttesa = [];
    await this.richiesta({ tipo: 'abbona', conversazioni: 'tutte' });
    const primaVolta = this.elenco.ultimoSeq === 0;
    if (primaVolta || !(await this.recupera())) {
      const { elenco } = await this.richiesta<{ elenco: ProiezioneElenco }>({ tipo: 'snapshot.elenco' });
      this.elenco = elenco;
    }
    // Le conversazioni aperte possono aver perso del testo in diretta: si rileggono.
    const aperte = [...this.conversazioni.keys()];
    this.conversazioni.clear();
    this.sincronizzato = true;
    for (const e of this.inAttesa) this.applica(e);
    this.inAttesa = [];
    await Promise.all(aperte.map((id) => this.carica(id)));
    this.notifica();
  }

  /** Eventi persi durante la disconnessione. false = troppi, meglio uno snapshot. */
  private async recupera(): Promise<boolean> {
    const massimo = this.opzioni.recuperoMassimo ?? 5000;
    let recuperati = 0;
    for (;;) {
      const { eventi } = await this.richiesta<{ eventi: Evento[] }>({ tipo: 'eventi.dopo', seq: this.elenco.ultimoSeq, limite: 1000 });
      for (const e of eventi) this.elenco = riduciElenco(this.elenco, e);
      recuperati += eventi.length;
      if (eventi.length < 1000) return true;
      if (recuperati >= massimo) return false;
    }
  }

  private ricevi(b: Busta): void {
    if (b.tipo === 'risposta') {
      const fine = this.risposte.get(b.id);
      this.risposte.delete(b.id);
      fine?.(b);
      return;
    }
    if (b.tipo !== 'evento') return;
    if (!this.sincronizzato) {
      this.inAttesa.push(b.evento);
      return;
    }
    this.applica(b.evento);
  }

  private applica(e: Evento): void {
    let cambiato = false;
    const nuovo = riduciElenco(this.elenco, e);
    if (nuovo !== this.elenco) {
      this.elenco = nuovo;
      cambiato = true;
    }
    const id = e.conversazioneId;
    // In caricamento: l'evento è già compreso nello snapshot in arrivo.
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

  private invia(busta: Busta & { id: string }): Promise<Busta> {
    const ws = this.ws;
    if (!ws || !ws.aperto()) return Promise.resolve(rispostaErrore('Non collegato.'));
    return new Promise((risolvi) => {
      this.risposte.set(busta.id, risolvi);
      ws.invia(JSON.stringify(busta));
    });
  }

  private riprova(): void {
    const attesa = Math.min(this.opzioni.attesaMassimaMs ?? 15_000, 250 * 2 ** this.tentativi++);
    setTimeout(() => {
      if (!this.chiuso) this.connetti().catch(() => this.riprova());
    }, attesa);
  }

  private notifica(): void {
    this.opzioni.onCambio?.();
  }
}

function rispostaErrore(errore: string): Busta {
  return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: '', esito: { ok: false, errore } };
}
