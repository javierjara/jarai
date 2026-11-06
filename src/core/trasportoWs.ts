import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { VERSIONE_PROTOCOLLO, type Busta, type Evento } from '../shared/protocollo';
import type { Host, Origine } from './host';

// L'host raggiungibile via WebSocket (docs/eventstore-protocollo.md §5.2):
// stessa busta dell'IPC, un'altra strada. Oggi serve al client di prova
// (passo 6); poi è il trasporto di JarAI Server e il pezzo che parla con il
// relay. Niente Electron.
//
// Ogni connessione si autentica con un token (nell'URL: ?token=...) e
// riceve solo gli eventi a cui si è abbonata. L'origine (dispositivo,
// utente) la decide il server dal token, mai il client.

export interface OpzioniTrasportoWs {
  porta: number;
  /** Solo 127.0.0.1 per le prove; su JarAI Server dietro il reverse proxy. */
  indirizzo?: string;
  /** Dal token all'origine dei comandi; null = connessione rifiutata. */
  autentica: (token: string | null) => Origine | null;
  /** Busta più grande di così: connessione chiusa (un documento non passa di qui). */
  massimaBusta?: number;
}

export interface TrasportoWs {
  porta: number;
  connessioni: () => number;
  chiudi: () => Promise<void>;
}

const BATTITO_MS = 30_000;
const CHIUSURA_NON_AUTORIZZATO = 4401;

interface Connessione {
  ws: WebSocket;
  origine: Origine;
  abbonamento: 'tutte' | Set<string> | null;
  viva: boolean;
}

export function avviaTrasportoWs(host: Host, opzioni: OpzioniTrasportoWs): Promise<TrasportoWs> {
  const connessioni = new Set<Connessione>();
  const wss = new WebSocketServer({
    port: opzioni.porta,
    host: opzioni.indirizzo ?? '127.0.0.1',
    maxPayload: opzioni.massimaBusta ?? 1024 * 1024,
  });

  const invia = (c: Connessione, busta: Busta) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(busta));
  };

  const smettiEventi = host.abbona((evento: Evento) => {
    for (const c of connessioni) {
      const a = c.abbonamento;
      if (!a) continue;
      // Eventi senza conversazione (entita_cambiata) vanno a tutti gli abbonati.
      if (a !== 'tutte' && evento.conversazioneId && !a.has(evento.conversazioneId)) continue;
      invia(c, { v: VERSIONE_PROTOCOLLO, tipo: 'evento', evento });
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
    const origine = opzioni.autentica(token);
    if (!origine) {
      ws.close(CHIUSURA_NON_AUTORIZZATO, 'non autorizzato');
      return;
    }
    const c: Connessione = { ws, origine, abbonamento: null, viva: true };
    connessioni.add(c);

    ws.on('pong', () => {
      c.viva = true;
    });
    ws.on('close', () => connessioni.delete(c));
    ws.on('message', (dati) => {
      void (async () => {
        let busta: unknown;
        try {
          busta = JSON.parse(String(dati));
        } catch {
          invia(c, { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: '', esito: { ok: false, errore: 'Richiesta non valida.' } });
          return;
        }
        // L'abbonamento è della connessione: lo si registra qui, l'host
        // risponde solo che è andato a buon fine.
        const r = (busta as { tipo?: string; richiesta?: { tipo?: string; conversazioni?: unknown } }).richiesta;
        if ((busta as { tipo?: string }).tipo === 'richiesta' && r?.tipo === 'abbona') {
          c.abbonamento = r.conversazioni === 'tutte' ? 'tutte' : new Set(Array.isArray(r.conversazioni) ? r.conversazioni.map(String) : []);
        }
        invia(c, await host.gestisciBusta(busta, c.origine));
      })();
    });
  });

  // Connessioni cadute senza chiudersi (telefono in tasca, rete persa).
  const battito = setInterval(() => {
    for (const c of connessioni) {
      if (!c.viva) {
        c.ws.terminate();
        connessioni.delete(c);
        continue;
      }
      c.viva = false;
      c.ws.ping();
    }
  }, BATTITO_MS);

  return new Promise((risolvi, rifiuta) => {
    wss.once('error', rifiuta);
    wss.once('listening', () => {
      const indirizzo = wss.address();
      risolvi({
        porta: typeof indirizzo === 'object' && indirizzo ? indirizzo.port : opzioni.porta,
        connessioni: () => connessioni.size,
        chiudi: () =>
          new Promise<void>((fatto) => {
            clearInterval(battito);
            smettiEventi();
            for (const c of connessioni) c.ws.terminate();
            wss.close(() => fatto());
          }),
      });
    });
  });
}
