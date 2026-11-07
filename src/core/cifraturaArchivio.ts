import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

// Server privato: i file delle pratiche viaggiano e restano sul server
// cifrati con una chiave che sta solo sul computer dello studio. Il server
// conserva dati che non può leggere.
//
// Formato (v1):  "JRA1" | sale (16 byte) | blocchi
//   ogni blocco = AES-256-GCM(testo ≤ 1 MiB) + tag (16 byte)
//   chiave del file = HKDF-SHA256(chiave studio, sale, "jarai-archivio-v1")
//   nonce = numero del blocco (11 byte) + 1 se è l'ultimo
// L'intestazione è nei dati autenticati; il segno "ultimo" nel nonce fa
// scoprire un file troncato. Un file vuoto ha un solo blocco vuoto.

const MAGIA = Buffer.from('JRA1');
const SALE = 16;
const TAG = 16;
export const BLOCCO = 1024 * 1024;
const INTESTAZIONE = MAGIA.length + SALE;

function chiaveFile(chiave: Uint8Array, sale: Buffer): Buffer {
  if (chiave.length !== 32) throw new Error('chiave dello studio non valida');
  return Buffer.from(hkdfSync('sha256', chiave, sale, 'jarai-archivio-v1', 32));
}

function nonce(numero: number, ultimo: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntBE(numero, 5, 6); // fino a 2^48 blocchi: abbondante
  n[11] = ultimo ? 1 : 0;
  return n;
}

/** Dimensione del file cifrato, per l'header Content-Length. */
export function dimensioneCifrata(dimensione: number): number {
  const blocchi = Math.max(1, Math.ceil(dimensione / BLOCCO));
  return INTESTAZIONE + dimensione + blocchi * TAG;
}

/**
 * Impronta da mandare al server per riconoscere i file cambiati: HMAC con la
 * chiave dello studio dell'impronta vera, così il server non può confrontarla
 * con documenti noti.
 */
export function improntaOpaca(chiave: Uint8Array, sha256: string): string {
  return createHmac('sha256', chiave).update(`archivio:${sha256}`).digest('hex');
}

/** Cifra un flusso di byte nel formato v1. */
export function cifra(chiave: Uint8Array): Transform {
  const sale = randomBytes(SALE);
  const intestazione = Buffer.concat([MAGIA, sale]);
  const k = chiaveFile(chiave, sale);
  let numero = 0;
  let attesa = Buffer.alloc(0);
  let iniziato = false;

  const sigilla = (testo: Buffer, ultimo: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', k, nonce(numero++, ultimo));
    c.setAAD(intestazione);
    return Buffer.concat([c.update(testo), c.final(), c.getAuthTag()]);
  };

  return new Transform({
    transform(pezzo: Buffer, _enc, cb: TransformCallback) {
      if (!iniziato) {
        this.push(intestazione);
        iniziato = true;
      }
      attesa = Buffer.concat([attesa, pezzo]);
      // Si tiene sempre almeno un blocco da parte: l'ultimo va segnato come tale.
      while (attesa.length > BLOCCO) {
        this.push(sigilla(attesa.subarray(0, BLOCCO), false));
        attesa = attesa.subarray(BLOCCO);
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!iniziato) this.push(intestazione);
      this.push(sigilla(attesa, true));
      cb();
    },
  });
}

/** Decifra un flusso nel formato v1; errore se è alterato o troncato. */
export function decifra(chiave: Uint8Array): Transform {
  let intestazione: Buffer | null = null;
  let k: Buffer | null = null;
  let numero = 0;
  let attesa = Buffer.alloc(0);
  const PIENO = BLOCCO + TAG;

  const apri = (blocco: Buffer, ultimo: boolean): Buffer => {
    const d = createDecipheriv('aes-256-gcm', k!, nonce(numero++, ultimo));
    d.setAAD(intestazione!);
    d.setAuthTag(blocco.subarray(blocco.length - TAG));
    return Buffer.concat([d.update(blocco.subarray(0, blocco.length - TAG)), d.final()]);
  };

  return new Transform({
    transform(pezzo: Buffer, _enc, cb: TransformCallback) {
      try {
        attesa = Buffer.concat([attesa, pezzo]);
        if (!intestazione) {
          if (attesa.length < INTESTAZIONE) return cb();
          intestazione = attesa.subarray(0, INTESTAZIONE);
          if (!intestazione.subarray(0, MAGIA.length).equals(MAGIA)) throw new Error('non è un file cifrato di JarAI');
          k = chiaveFile(chiave, intestazione.subarray(MAGIA.length));
          attesa = attesa.subarray(INTESTAZIONE);
        }
        while (attesa.length > PIENO) {
          this.push(apri(attesa.subarray(0, PIENO), false));
          attesa = attesa.subarray(PIENO);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!intestazione || attesa.length < TAG) throw new Error('file cifrato incompleto');
        this.push(apri(attesa, true));
        cb();
      } catch (err) {
        cb(err instanceof Error && /auth/i.test(err.message) ? new Error('file cifrato alterato o incompleto') : (err as Error));
      }
    },
  });
}
