import { VERSIONE_PROTOCOLLO, type Busta, type Evento } from '../shared/protocollo';
import { casuale, cifra, decifra, derivaChiavi, impronta, type ChiaviSessione } from '../shared/cifratura';
import { CHIUSURA } from '../shared/clienteRemoto';
import {
  codificaInvito,
  salePer,
  VERSIONE_RELAY,
  type ContenutoAbbinamento,
  type EsitoAbbinamento,
  type RichiestaAbbinamento,
} from '../shared/relay';
import type { Database } from './db';
import { aggiungiTelefono, dispositivoAttivo, revocaDispositivo } from './dispositivi';
import type { Host } from './host';

// Il ponte tra l'host del desktop e i telefoni, attraverso jarai-relay.
// Il desktop apre lui la connessione (in uscita: niente porte aperte nello
// studio) e la tiene viva. Per ogni telefono: decifra la busta, la passa
// all'host con l'origine del dispositivo, cifra risposte ed eventi.
// Il relay vede solo testo cifrato e chi parla con chi.
//
// Niente Electron qui: identità, conferma e salvataggio li passa chi lo avvia
// (src/main/telefono.ts).

export interface IdentitaDesktop {
  hostId: string;
  /** Lega la stanza del relay a questo computer. */
  segreto: string;
  privata: string;
  pubblica: string;
}

export interface OpzioniPonte {
  relay: string;
  identita: IdentitaDesktop;
  host: Host;
  db: Database;
  /** Nome del computer nel QR e sul telefono. */
  nomeComputer?: string;
  /** L'avvocato conferma il nuovo telefono. false = rifiutato. */
  conferma: (nomeTelefono: string) => Promise<boolean>;
  onStato?: (s: StatoPonte) => void;
  onDispositivi?: () => void;
  orologio?: () => string;
  registraErrore?: (contesto: string, dettaglio: string) => void;
  durataInvitoMs?: number;
}

export type StatoPonte = 'collegamento' | 'collegato' | 'scollegato' | 'sostituito' | 'rifiutato' | 'fermo';

const BATTITO_MS = 25_000;
const SILENZIO_MASSIMO_MS = 70_000;
const CHIUSURA_SOSTITUITO = 4409;

interface Sessione {
  chiavi: ChiaviSessione;
  abbonamento: 'tutte' | Set<string> | null;
  /** WebCrypto è asincrona: la coda tiene l'ordine di risposte ed eventi. */
  coda: Promise<void>;
}

export class PonteRelay {
  stato: StatoPonte = 'fermo';
  private ws: WebSocket | null = null;
  private fermo = true;
  private tentativi = 0;
  private ultimo = 0;
  private battito: ReturnType<typeof setInterval> | null = null;
  private riprovaTimer: ReturnType<typeof setTimeout> | null = null;
  private smettiEventi: (() => void) | null = null;
  private readonly sessioni = new Map<string, Sessione>();
  /** Segreti dei QR ancora validi → scadenza. */
  private readonly inviti = new Map<string, number>();
  private readonly orologio: () => string;
  private readonly registraErrore: (contesto: string, dettaglio: string) => void;

  constructor(private readonly o: OpzioniPonte) {
    this.orologio = o.orologio ?? (() => new Date().toISOString());
    this.registraErrore = o.registraErrore ?? (() => undefined);
  }

  avvia(): void {
    if (!this.fermo) return;
    this.fermo = false;
    this.smettiEventi = this.o.host.abbona((e) => this.distribuisci(e));
    this.collega();
  }

  ferma(): void {
    this.fermo = true;
    this.smettiEventi?.();
    this.smettiEventi = null;
    if (this.riprovaTimer) clearTimeout(this.riprovaTimer);
    this.chiudiConnessione();
    this.sessioni.clear();
    this.imposta('fermo');
  }

  /** Nuovo QR, valido pochi minuti e una volta sola. */
  async nuovoInvito(): Promise<{ qr: string; scade: number }> {
    if (this.stato !== 'collegato') throw new Error('Il computer non è collegato al servizio: controlla la connessione.');
    const segreto = casuale(32);
    const scade = Date.now() + (this.o.durataInvitoMs ?? 5 * 60_000);
    this.inviti.set(segreto, scade);
    this.controllo({ tipo: 'registra-abbinamento', impronta: await impronta(await impronta(segreto)), scade });
    const { hostId, pubblica } = this.o.identita;
    return { qr: codificaInvito({ relay: this.o.relay, hostId, chiave: pubblica, segreto, nome: this.o.nomeComputer }), scade };
  }

  /** Scollega un telefono: subito se il relay è raggiungibile, comunque mai più accettato. */
  revoca(dispositivoId: string): void {
    revocaDispositivo(this.o.db, dispositivoId, this.orologio());
    this.sessioni.delete(dispositivoId);
    this.controllo({ tipo: 'revoca', dispositivo: dispositivoId });
    this.o.onDispositivi?.();
  }

  // ─── Connessione al relay ─────────────────────────────────────────────

  private collega(): void {
    if (this.fermo) return;
    this.imposta('collegamento');
    const { hostId, segreto } = this.o.identita;
    const ws = new WebSocket(`${this.o.relay.replace(/\/+$/, '')}/host/${hostId}?segreto=${encodeURIComponent(segreto)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.tentativi = 0;
      this.ultimo = Date.now();
      this.imposta('collegato');
      this.battito = setInterval(() => {
        if (Date.now() - this.ultimo > SILENZIO_MASSIMO_MS) {
          // Rete persa senza chiusura (il Mac si è addormentato): si riparte.
          this.chiudiConnessione();
          this.dopoChiusura(1006);
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, BATTITO_MS);
    };
    ws.onmessage = (m) => {
      this.ultimo = Date.now();
      const testo = String(m.data);
      if (testo === 'pong') return;
      void this.ricevi(testo).catch((err) => this.registraErrore('ponte', err instanceof Error ? err.message : String(err)));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.chiudiConnessione();
      this.dopoChiusura(e.code);
    };
  }

  private dopoChiusura(codice: number): void {
    this.sessioni.clear();
    if (this.fermo) return;
    if (codice === CHIUSURA_SOSTITUITO) return this.imposta('sostituito');
    // La stanza è legata a un altro segreto: riprovare non serve.
    if (codice === CHIUSURA.nonAutorizzato) return this.imposta('rifiutato');
    this.imposta('scollegato');
    const attesa = Math.min(30_000, 500 * 2 ** this.tentativi++);
    this.riprovaTimer = setTimeout(() => this.collega(), attesa);
  }

  private chiudiConnessione(): void {
    if (this.battito) clearInterval(this.battito);
    this.battito = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // già chiusa
    }
  }

  private imposta(s: StatoPonte): void {
    if (this.stato === s) return;
    this.stato = s;
    this.o.onStato?.(s);
  }

  private controllo(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ─── Messaggi ─────────────────────────────────────────────────────────

  private async ricevi(testo: string): Promise<void> {
    let m: { tipo?: string; da?: string; dati?: string };
    try {
      m = JSON.parse(testo);
    } catch {
      return;
    }
    if (m.tipo === 'scollegato' && m.da) {
      this.sessioni.delete(m.da);
      return;
    }
    if (m.tipo !== 'dati' || !m.da || typeof m.dati !== 'string') return;
    if (m.da.startsWith('abbina:')) return this.abbinamento(m.da, m.dati);

    const id = m.da;
    const s = await this.sessione(id);
    if (!s) {
      // Sconosciuto o revocato mentre il relay non era raggiungibile.
      this.controllo({ tipo: 'revoca', dispositivo: id });
      return;
    }
    let busta: unknown;
    try {
      busta = JSON.parse(await decifra(s.chiavi.versoDesktop, m.dati));
    } catch {
      return; // alterato o vecchia sessione
    }
    // Come trasportoWs: l'abbonamento è della connessione.
    const r = (busta as { tipo?: string; richiesta?: { tipo?: string; conversazioni?: unknown } }).richiesta;
    if ((busta as { tipo?: string }).tipo === 'richiesta' && r?.tipo === 'abbona') {
      s.abbonamento = r.conversazioni === 'tutte' ? 'tutte' : new Set(Array.isArray(r.conversazioni) ? r.conversazioni.map(String) : []);
    }
    const risposta = await this.o.host.gestisciBusta(busta, { dispositivoId: id });
    this.inviaA(id, s, risposta);
  }

  private async sessione(id: string): Promise<Sessione | null> {
    const esistente = this.sessioni.get(id);
    if (esistente) return esistente;
    const d = dispositivoAttivo(this.o.db, id);
    if (!d?.chiavePubblica) return null;
    const chiavi = await derivaChiavi(this.o.identita.privata, d.chiavePubblica, salePer(this.o.identita.hostId, id));
    // Nel frattempo potrebbe averla creata un altro messaggio.
    const s = this.sessioni.get(id) ?? { chiavi, abbonamento: null, coda: Promise.resolve() };
    this.sessioni.set(id, s);
    return s;
  }

  private inviaA(id: string, s: Sessione, busta: Busta): void {
    s.coda = s.coda
      .then(async () => {
        const dati = await cifra(s.chiavi.versoTelefono, JSON.stringify(busta));
        this.controllo({ tipo: 'inoltra', a: id, dati });
      })
      .catch((err) => this.registraErrore('ponte', err instanceof Error ? err.message : String(err)));
  }

  private distribuisci(evento: Evento): void {
    for (const [id, s] of this.sessioni) {
      const a = s.abbonamento;
      if (!a) continue;
      if (a !== 'tutte' && evento.conversazioneId && !a.has(evento.conversazioneId)) continue;
      this.inviaA(id, s, { v: VERSIONE_PROTOCOLLO, tipo: 'evento', evento });
    }
  }

  private async abbinamento(da: string, testo: string): Promise<void> {
    let r: RichiestaAbbinamento;
    try {
      r = JSON.parse(testo);
    } catch {
      return;
    }
    if (r.tipo !== 'abbina' || r.v !== VERSIONE_RELAY || !r.dispositivo || !r.chiave || !/^[A-Za-z0-9_-]{16,64}$/.test(r.dispositivo)) {
      return this.controllo({ tipo: 'chiudi', a: da });
    }
    const { hostId, privata } = this.o.identita;
    let chiavi: ChiaviSessione;
    let contenuto: ContenutoAbbinamento;
    try {
      chiavi = await derivaChiavi(privata, r.chiave, salePer(hostId, r.dispositivo));
      contenuto = JSON.parse(await decifra(chiavi.versoDesktop, r.dati));
    } catch {
      return this.controllo({ tipo: 'chiudi', a: da });
    }
    const rispondi = async (esito: EsitoAbbinamento) => {
      this.controllo({ tipo: 'inoltra', a: da, dati: await cifra(chiavi.versoTelefono, JSON.stringify(esito)) });
      this.controllo({ tipo: 'chiudi', a: da });
    };
    const scade = this.inviti.get(contenuto.segreto);
    // Monouso: tolto subito, prima ancora della conferma.
    this.inviti.delete(contenuto.segreto);
    this.controllo({ tipo: 'consuma-abbinamento', impronta: await impronta(await impronta(contenuto.segreto)) });
    if (!scade || scade < Date.now()) return rispondi({ tipo: 'rifiutato', motivo: 'Codice scaduto: genera un nuovo QR sul computer.' });
    if (typeof contenuto.token !== 'string' || contenuto.token.length < 32) return rispondi({ tipo: 'rifiutato', motivo: 'Richiesta non valida.' });
    const nome = String(contenuto.nome || 'Telefono').slice(0, 80);

    if (!(await this.o.conferma(nome))) return rispondi({ tipo: 'rifiutato', motivo: 'Collegamento rifiutato sul computer.' });
    aggiungiTelefono(this.o.db, { id: r.dispositivo, nome, chiavePubblica: r.chiave, quando: this.orologio() });
    this.controllo({ tipo: 'autorizza', dispositivo: r.dispositivo, impronta: await impronta(contenuto.token) });
    await rispondi({ tipo: 'abbinato', nome: this.o.nomeComputer });
    this.o.onDispositivi?.();
  }
}
