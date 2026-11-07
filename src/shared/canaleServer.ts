import type { AccessoServer } from './archivio';
import type { Canale } from './clienteRemoto';

// Il canale verso l'assistente di riserva sul server privato (src/server/
// canaleTelefono.ts), per ClienteRemoto: WebSocket su TLS, primo messaggio
// con token e chiave dello studio, poi la busta di sempre.
// Solo API standard: gira in React Native e in Node (prove).

/** Chiave dello studio cambiata o server non ancora preparato dal computer. */
export const CHIUSURA_SERVER_NON_PRONTO = 4002;

export function indirizzoCanaleServer(url: string): string {
  return `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/telefono/ws`;
}

export function canaleServer(accesso: AccessoServer, onErrore?: (messaggio: string) => void): Canale {
  const ws = new WebSocket(indirizzoCanaleServer(accesso.url));
  let aperto = false;
  let chiuso = false;
  const c: Canale = {
    aperto: () => aperto && ws.readyState === WebSocket.OPEN,
    invia: (t) => ws.send(t),
    chiudi: () => {
      chiuso = true;
      ws.close();
    },
  };
  ws.onopen = () => ws.send(JSON.stringify({ tipo: 'accedi', token: accesso.token, chiave: accesso.chiave }));
  ws.onmessage = (m) => {
    const testo = String(m.data);
    if (!aperto) {
      try {
        const r = JSON.parse(testo) as { tipo?: string; ok?: boolean; errore?: string };
        if (r.tipo !== 'accesso') return;
        if (r.ok) {
          aperto = true;
          c.onapri?.();
        } else if (r.errore) onErrore?.(r.errore);
      } catch {
        // risposta non valida: la chiusura arriverà dal server
      }
      return;
    }
    c.onmessaggio?.(testo);
  };
  ws.onclose = (e) => {
    aperto = false;
    c.onchiuso?.(chiuso ? 1000 : e.code);
  };
  return c;
}
