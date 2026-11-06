import { CHIUSURA, type Canale } from './clienteRemoto';
import { casuale, cifra, decifra, derivaChiavi, generaCoppia, impronta, type ChiaviSessione } from './cifratura';

// Telefono ↔ relay ↔ desktop (jarai-relay). Questo file è la parte che gira
// sul telefono (app React Native, test) più il formato del QR e i messaggi
// di abbinamento, che usa anche il desktop (src/core/ponteRelay.ts).
//
// Abbinamento:
//   1. Il desktop mostra un QR: relay, hostId, sua chiave pubblica, segreto S
//      (monouso, pochi minuti). Al relay dice solo l'impronta di impronta(S).
//   2. Il telefono si collega a /abbina/<hostId>?codice=impronta(S): il relay
//      lo lascia entrare ma non conosce S.
//   3. Il telefono manda in chiaro la sua chiave pubblica e il suo id, e
//      cifrato (chiavi ECDH con la pubblica del QR) S, il token e il nome.
//      Solo chi ha visto il QR conosce S; solo il desktop può decifrare.
//      Un relay che sostituisse la chiave del telefono non saprebbe S.
//   4. Il desktop chiede conferma all'avvocato, registra il dispositivo e
//      dice al relay l'impronta del token. Da lì il telefono entra da
//      /telefono/<hostId>?dispositivo=…&token=… e tutto passa cifrato.

export const VERSIONE_RELAY = 1;
const BATTITO_MS = 25_000;
const SILENZIO_MASSIMO_MS = 70_000;
const ATTESA_ABBINAMENTO_MS = 3 * 60_000;

/** Il contenuto del QR. */
export interface InvitoAbbinamento {
  relay: string;
  hostId: string;
  /** Chiave pubblica del desktop. */
  chiave: string;
  segreto: string;
  /** Nome del computer, solo da mostrare. */
  nome?: string;
}

/** Quello che il telefono conserva (nel portachiavi) dopo l'abbinamento. */
export interface CredenzialiTelefono {
  relay: string;
  hostId: string;
  dispositivoId: string;
  token: string;
  /** Chiave privata del telefono (base64url). */
  privata: string;
  chiaveDesktop: string;
  nomeComputer?: string;
}

/** Primo messaggio del telefono nella stanza di abbinamento. */
export interface RichiestaAbbinamento {
  tipo: 'abbina';
  v: number;
  dispositivo: string;
  chiave: string;
  /** Cifrato verso il desktop: ContenutoAbbinamento. */
  dati: string;
}

export interface ContenutoAbbinamento {
  segreto: string;
  token: string;
  nome: string;
}

/** Risposta del desktop, cifrata verso il telefono. */
export type EsitoAbbinamento = { tipo: 'abbinato'; nome?: string } | { tipo: 'rifiutato'; motivo: string };

export const salePer = (hostId: string, dispositivoId: string) => `${hostId}:${dispositivoId}`;

export function codificaInvito(i: InvitoAbbinamento): string {
  const p = new URLSearchParams({ r: i.relay, h: i.hostId, k: i.chiave, s: i.segreto });
  if (i.nome) p.set('n', i.nome);
  return `jarai://collega?${p.toString()}`;
}

export function leggiInvito(testo: string): InvitoAbbinamento | null {
  const m = /^jarai:\/\/collega\?(.*)$/.exec(testo.trim());
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const relay = p.get('r');
  const hostId = p.get('h');
  const chiave = p.get('k');
  const segreto = p.get('s');
  if (!relay || !/^wss?:\/\//.test(relay) || !hostId || !chiave || !segreto) return null;
  return { relay, hostId, chiave, segreto, nome: p.get('n') ?? undefined };
}

const indirizzo = (relay: string, percorso: string) => `${relay.replace(/\/+$/, '')}${percorso}`;

/**
 * Lato telefono: dal QR alle credenziali. Si risolve quando l'avvocato
 * conferma sul computer; lancia un errore se rifiuta, se il codice è scaduto
 * o se il computer non è collegato.
 */
export async function abbinaTelefono(invito: InvitoAbbinamento, nomeTelefono: string): Promise<CredenzialiTelefono> {
  const coppia = await generaCoppia();
  const dispositivoId = casuale(16);
  const token = casuale(32);
  const chiavi = await derivaChiavi(coppia.privata, invito.chiave, salePer(invito.hostId, dispositivoId));
  const codice = await impronta(invito.segreto);
  const url = indirizzo(invito.relay, `/abbina/${invito.hostId}?codice=${encodeURIComponent(codice)}`);

  const esito = await new Promise<EsitoAbbinamento>((risolvi, rifiuta) => {
    const ws = new WebSocket(url);
    let finito = false;
    const fine = (e: Error | EsitoAbbinamento) => {
      if (finito) return;
      finito = true;
      clearTimeout(timer);
      ws.close();
      if (e instanceof Error) rifiuta(e);
      else risolvi(e);
    };
    const timer = setTimeout(() => fine(new Error('Nessuna conferma dal computer: riprova.')), ATTESA_ABBINAMENTO_MS);
    let inviato = false;
    ws.onmessage = (m) => {
      void (async () => {
        const msg = JSON.parse(String(m.data)) as { tipo?: string; online?: boolean; dati?: string };
        if (msg.tipo === 'host') {
          if (!msg.online) return fine(new Error('Il computer dello studio non è collegato: apri JarAI sul computer.'));
          if (inviato) return;
          inviato = true;
          const contenuto: ContenutoAbbinamento = { segreto: invito.segreto, token, nome: nomeTelefono };
          const richiesta: RichiestaAbbinamento = {
            tipo: 'abbina',
            v: VERSIONE_RELAY,
            dispositivo: dispositivoId,
            chiave: coppia.pubblica,
            dati: await cifra(chiavi.versoDesktop, JSON.stringify(contenuto)),
          };
          ws.send(JSON.stringify(richiesta));
        } else if (msg.tipo === 'dati' && msg.dati) {
          try {
            fine(JSON.parse(await decifra(chiavi.versoTelefono, msg.dati)) as EsitoAbbinamento);
          } catch {
            fine(new Error('Risposta non valida dal computer.'));
          }
        }
      })();
    };
    ws.onclose = (e) => {
      fine(new Error(e.code === CHIUSURA.nonAutorizzato ? 'Codice scaduto o già usato: genera un nuovo QR sul computer.' : 'Collegamento interrotto.'));
    };
  });
  if (esito.tipo !== 'abbinato') throw new Error(esito.motivo);
  return {
    relay: invito.relay,
    hostId: invito.hostId,
    dispositivoId,
    token,
    privata: coppia.privata,
    chiaveDesktop: invito.chiave,
    nomeComputer: esito.nome ?? invito.nome,
  };
}

/**
 * Lato telefono: il canale cifrato per ClienteRemoto. "Aperto" solo quando
 * il computer è collegato; se il computer si scollega il canale si chiude
 * (hostAssente) e il client riprova da solo.
 */
export function canaleRelay(credenziali: CredenzialiTelefono): Canale {
  const url = indirizzo(
    credenziali.relay,
    `/telefono/${credenziali.hostId}?dispositivo=${encodeURIComponent(credenziali.dispositivoId)}&token=${encodeURIComponent(credenziali.token)}`,
  );
  const ws = new WebSocket(url);
  let chiavi: ChiaviSessione | null = null;
  let aperto = false;
  let chiuso = false;
  let ultimo = Date.now();
  // WebCrypto è asincrona: le code tengono l'ordine dei messaggi.
  let codaIn: Promise<void> = Promise.resolve();
  let codaOut: Promise<void> = Promise.resolve();
  const pronte = (async () => {
    chiavi = await derivaChiavi(
      credenziali.privata,
      credenziali.chiaveDesktop,
      salePer(credenziali.hostId, credenziali.dispositivoId),
    );
  })();

  const chiudi = (codice: number) => {
    if (chiuso) return;
    chiuso = true;
    aperto = false;
    clearInterval(battito);
    try {
      ws.close();
    } catch {
      // già chiuso
    }
    c.onchiuso?.(codice);
  };

  const battito = setInterval(() => {
    if (Date.now() - ultimo > SILENZIO_MASSIMO_MS) return chiudi(1006);
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, BATTITO_MS);

  const c: Canale = {
    aperto: () => aperto,
    invia: (testo) => {
      codaOut = codaOut.then(async () => {
        await pronte;
        if (ws.readyState === WebSocket.OPEN && chiavi) ws.send(await cifra(chiavi.versoDesktop, testo));
      });
    },
    chiudi: () => chiudi(1000),
  };

  ws.onmessage = (m) => {
    ultimo = Date.now();
    const testo = String(m.data);
    if (testo === 'pong') return;
    codaIn = codaIn.then(async () => {
      let msg: { tipo?: string; online?: boolean; dati?: string };
      try {
        msg = JSON.parse(testo);
      } catch {
        return;
      }
      if (msg.tipo === 'host') {
        if (msg.online && !aperto) {
          await pronte;
          aperto = true;
          c.onapri?.();
        } else if (!msg.online) chiudi(CHIUSURA.hostAssente);
      } else if (msg.tipo === 'dati' && msg.dati && chiavi && aperto) {
        let chiaro: string;
        try {
          chiaro = await decifra(chiavi.versoTelefono, msg.dati);
        } catch {
          return; // alterato o di un'altra sessione: si ignora
        }
        c.onmessaggio?.(chiaro);
      }
    });
  };
  ws.onclose = (e) => chiudi(e.code);
  return c;
}
