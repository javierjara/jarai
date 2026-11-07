import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Host } from '../core/host';
import { VERSIONE_PROTOCOLLO, type Busta, type Evento } from '../shared/protocollo';
import { ErroreStudio, type StudioServer } from './studio';

// I telefoni collegati parlano con l'assistente di riserva su
// wss://<server>/telefono/ws (TLS dal reverse proxy). Il primo messaggio è
//   { tipo: 'accedi', token: '<id>.<token>', chiave: '<base64>' }
// token: quello di sola lettura dato dal computer (archivio.ts); chiave:
// la chiave dello studio, che il server tiene solo in memoria (studio.ts).
// Poi la stessa busta del desktop (src/shared/protocollo), come trasportoWs.

export const PERCORSO_TELEFONO = '/telefono/ws';
const CHIUSURA_NON_AUTORIZZATO = 4401;
/** Server non pronto o chiave cambiata: il telefono riprova (e si fa ridare l'accesso dal computer). */
const CHIUSURA_NON_PRONTO = 4002;
const ATTESA_ACCESSO_MS = 10_000;
const BATTITO_MS = 30_000;

export interface OpzioniCanale {
  telefonoDaToken: (token: string) => string | null;
  studio: StudioServer;
  massimaBusta?: number;
  registraErrore?: (contesto: string, dettaglio: string) => void;
}

interface Connessione {
  ws: WebSocket;
  dispositivoId: string;
  host: Host;
  abbonamento: 'tutte' | Set<string> | null;
  smetti: () => void;
  viva: boolean;
}

export function collegaCanaleTelefono(server: Server, o: OpzioniCanale): { chiudi: () => void; connessioni: () => number } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.massimaBusta ?? 1024 * 1024 });
  const connessioni = new Set<Connessione>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, testa: Buffer) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== PERCORSO_TELEFONO) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, testa, (ws) => accogli(ws));
  });

  const invia = (ws: WebSocket, m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };

  function accogli(ws: WebSocket): void {
    const scadenza = setTimeout(() => ws.close(CHIUSURA_NON_AUTORIZZATO, 'accesso mancante'), ATTESA_ACCESSO_MS);
    ws.once('message', (dati) => {
      clearTimeout(scadenza);
      void (async () => {
        let m: { tipo?: string; token?: unknown; chiave?: unknown };
        try {
          m = JSON.parse(String(dati));
        } catch {
          return ws.close(CHIUSURA_NON_AUTORIZZATO, 'accesso non valido');
        }
        const id = m.tipo === 'accedi' && typeof m.token === 'string' ? o.telefonoDaToken(m.token) : null;
        if (!id || typeof m.chiave !== 'string') {
          invia(ws, { tipo: 'accesso', ok: false, errore: 'Telefono non autorizzato.' });
          return ws.close(CHIUSURA_NON_AUTORIZZATO, 'non autorizzato');
        }
        const chiave = Buffer.from(m.chiave, 'base64');
        let host: Host;
        try {
          host = await o.studio.apri(chiave);
        } catch (err) {
          const errore = err instanceof ErroreStudio ? err.message : 'Il server dello studio non è pronto.';
          if (!(err instanceof ErroreStudio)) o.registraErrore?.('apertura', err instanceof Error ? err.message : String(err));
          invia(ws, { tipo: 'accesso', ok: false, errore });
          return ws.close(CHIUSURA_NON_PRONTO, 'non pronto');
        } finally {
          chiave.fill(0);
        }
        if (ws.readyState !== ws.OPEN) return;
        o.studio.entra();
        const c: Connessione = { ws, dispositivoId: id, host, abbonamento: null, smetti: () => undefined, viva: true };
        c.smetti = host.abbona((e: Evento) => {
          const a = c.abbonamento;
          if (!a || (a !== 'tutte' && e.conversazioneId && !a.has(e.conversazioneId))) return;
          invia(ws, { v: VERSIONE_PROTOCOLLO, tipo: 'evento', evento: e } satisfies Busta);
        });
        connessioni.add(c);
        ws.on('pong', () => {
          c.viva = true;
        });
        ws.on('close', () => {
          if (!connessioni.delete(c)) return;
          c.smetti();
          o.studio.esce();
        });
        ws.on('message', (d) => void ricevi(c, String(d)));
        invia(ws, { tipo: 'accesso', ok: true });
      })();
    });
  }

  async function ricevi(c: Connessione, testo: string): Promise<void> {
    let busta: unknown;
    try {
      busta = JSON.parse(testo);
    } catch {
      return invia(c.ws, { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: '', esito: { ok: false, errore: 'Richiesta non valida.' } });
    }
    const r = (busta as { tipo?: string; richiesta?: { tipo?: string; conversazioni?: unknown } }).richiesta;
    if ((busta as { tipo?: string }).tipo === 'richiesta' && r?.tipo === 'abbona') {
      c.abbonamento = r.conversazioni === 'tutte' ? 'tutte' : new Set(Array.isArray(r.conversazioni) ? r.conversazioni.map(String) : []);
    }
    invia(c.ws, await c.host.gestisciBusta(busta, { dispositivoId: c.dispositivoId }));
  }

  const battito = setInterval(() => {
    for (const c of connessioni) {
      if (!c.viva) {
        c.ws.terminate();
        continue;
      }
      c.viva = false;
      c.ws.ping();
    }
  }, BATTITO_MS);

  return {
    connessioni: () => connessioni.size,
    chiudi: () => {
      clearInterval(battito);
      for (const c of connessioni) c.ws.terminate();
      wss.close();
    },
  };
}
