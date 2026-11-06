import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Cifratura end-to-end tra desktop e telefono (spec §9.4). Il relay inoltra
// solo testo cifrato: non conosce le chiavi e non può leggere né alterare
// niente senza che il destinatario se ne accorga.
//
// - Chiavi: ECDH P-256. Desktop e telefono hanno ognuno la sua coppia; le
//   pubbliche si scambiano con il QR e con l'abbinamento.
// - Dal segreto comune (coordinata x, come WebCrypto), HKDF-SHA256 ricava due
//   chiavi AES-GCM 256, una per direzione, legate a quel computer e a quel
//   telefono (sale).
// - Ogni messaggio: IV casuale di 12 byte + testo cifrato con tag.
//
// Librerie @noble (JavaScript puro, verificate): lo stesso codice gira in
// Electron, Node e React Native (Hermes non ha WebCrypto). L'unica cosa
// richiesta all'ambiente è crypto.getRandomValues.

const VERSO_DESKTOP = 'jarai v1 telefono→desktop';
const VERSO_TELEFONO = 'jarai v1 desktop→telefono';

export interface CoppiaDiChiavi {
  /** Chiave pubblica non compressa (65 byte) in base64url: va nel QR. */
  pubblica: string;
  /** Chiave privata (32 byte) in base64url: da conservare cifrata (portachiavi). */
  privata: string;
}

export interface ChiaviSessione {
  versoDesktop: Uint8Array;
  versoTelefono: Uint8Array;
}

export async function generaCoppia(): Promise<CoppiaDiChiavi> {
  const privata = p256.utils.randomSecretKey();
  return { privata: base64url(privata), pubblica: base64url(p256.getPublicKey(privata, false)) };
}

/** Pubblica ricavata dalla privata salvata (per non doverla conservare a parte). */
export async function pubblicaDaPrivata(privata: string): Promise<string> {
  return base64url(p256.getPublicKey(daBase64url(privata), false));
}

/**
 * Le stesse due chiavi su entrambi i lati: il desktop chiama con la sua
 * privata e la pubblica del telefono, il telefono con la sua e quella del
 * desktop. sale = identificativi di computer e telefono.
 * Lancia un errore se la pubblica non è un punto valido della curva.
 */
export async function derivaChiavi(privata: string, pubblicaAltro: string, sale: string): Promise<ChiaviSessione> {
  const punto = p256.getSharedSecret(daBase64url(privata), daBase64url(pubblicaAltro), true);
  const segreto = punto.slice(1, 33);
  const s = utf8(sale);
  return {
    versoDesktop: hkdf(sha256, segreto, s, utf8(VERSO_DESKTOP), 32),
    versoTelefono: hkdf(sha256, segreto, s, utf8(VERSO_TELEFONO), 32),
  };
}

export async function cifra(chiave: Uint8Array, testo: string): Promise<string> {
  const iv = byteCasuali(12);
  const cifrato = gcm(chiave, iv).encrypt(utf8(testo));
  const tutto = new Uint8Array(iv.length + cifrato.length);
  tutto.set(iv);
  tutto.set(cifrato, iv.length);
  return base64url(tutto);
}

/** Lancia un errore se il messaggio è stato alterato o la chiave è sbagliata. */
export async function decifra(chiave: Uint8Array, dati: string): Promise<string> {
  const tutto = daBase64url(dati);
  if (tutto.length < 12 + 16) throw new Error('Messaggio troppo corto.');
  return daUtf8(gcm(chiave, tutto.slice(0, 12)).decrypt(tutto.slice(12)));
}

export function casuale(byte = 32): string {
  return base64url(byteCasuali(byte));
}

export async function impronta(testo: string): Promise<string> {
  return base64url(sha256(utf8(testo)));
}

function byteCasuali(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function base64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function daBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

// UTF-8 a mano: TextEncoder/TextDecoder non sono garantiti su ogni Hermes.
function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = Math.min(c, 0x10ffff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

function daUtf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const x = b[i++];
    let c: number;
    if (x < 0x80) c = x;
    else if (x < 0xe0) c = ((x & 31) << 6) | (b[i++] & 63);
    else if (x < 0xf0) c = ((x & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else c = ((x & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    s += String.fromCodePoint(c);
  }
  return s;
}
