import {
  VERSIONE_PROTOCOLLO,
  type Busta,
  type Comando,
  type EsitoComando,
  type Evento,
  type Richiesta,
} from './protocollo';
import { ELENCO_VUOTO, riduciConversazione, riduciElenco, type ProiezioneConversazione, type ProiezioneElenco } from './reducer';

// Client remoto dell'host (passo 6 e poi telefono): WebSocket, cursore,
// riconnessione. Usa solo il WebSocket standard, quindi gira uguale nel
// browser (PWA) e in Node 22+ (test, strumenti).
//
// Regola d'ordine: mentre aspetta uno snapshot o il recupero dopo una
// riconnessione, il client mette da parte gli eventi in diretta e li
// applica dopo. Il reducer scarta quelli già compresi (seq già visto).

type SenzaComandoId<T> = T extends unknown ? Omit<T, 'comandoId'> : never;

export interface OpzioniClienteRemoto {
  /** Es. ws://127.0.0.1:8787/?token=... */
  url: string;
  onCambio?: () => void;
  /** Ritardo massimo tra due tentativi di riconnessione. */
  attesaMassimaMs?: number;
  /** Oltre questo numero di eventi persi si riparte da uno snapshot. */
  recuperoMassimo?: number;
}

const nuovoId = () => crypto.randomUUID();
/** Stesso codice di src/core/trasportoWs.ts. */
const CHIUSURA_NON_AUTORIZZATO = 4401;

export class ClienteRemoto {
  elenco: ProiezioneElenco = ELENCO_VUOTO;
  connesso = false;
  private ws: WebSocket | null = null;
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
      const ws = new WebSocket(this.opzioni.url);
      this.ws = ws;
      let aperto = false;
      ws.onopen = () => {
        aperto = true;
        this.connesso = true;
        this.tentativi = 0;
        this.sincronizza().then(risolvi, rifiuta);
      };
      ws.onmessage = (m) => this.ricevi(JSON.parse(String(m.data)) as Busta);
      ws.onclose = (e) => {
        this.connesso = false;
        this.sincronizzato = false;
        // Rifiutato dall'host (token non valido o dispositivo revocato):
        // definitivo, riprovare non servirebbe.
        const nonAutorizzato = e.code === CHIUSURA_NON_AUTORIZZATO;
        if (nonAutorizzato) this.chiuso = true;
        const motivo = nonAutorizzato ? 'Non autorizzato.' : aperto ? 'Collegamento interrotto.' : 'Host non raggiungibile.';
        for (const fine of this.risposte.values()) fine(rispostaErrore(motivo));
        this.risposte.clear();
        this.notifica();
        if (!aperto || nonAutorizzato) rifiuta(new Error(motivo));
        else if (!this.chiuso) this.riprova();
      };
    });
  }

  chiudi(): void {
    this.chiuso = true;
    this.ws?.close();
  }

  /** Solo per le prove: la rete cade, il client si ricollega da solo. */
  simulaCaduta(): void {
    this.ws?.close();
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(rispostaErrore('Non collegato.'));
    return new Promise((risolvi) => {
      this.risposte.set(busta.id, risolvi);
      ws.send(JSON.stringify(busta));
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
