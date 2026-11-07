import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './cifratura';

// Archivio del server privato, la parte che serve anche al telefono:
// - la chiave con cui un documento sta sul server (impronta degli id, non
//   rivela nomi di clienti o pratiche);
// - la decifratura del formato "JRA1" (src/core/cifraturaArchivio.ts lo
//   scrive in streaming sul desktop; qui si legge un file intero);
// - il tipo di file dall'estensione.
// Solo @noble e JavaScript standard: gira in Electron, Node e React Native.

/** Accesso del telefono ai file del server privato (dal computer, cifrato). */
export interface AccessoServer {
  url: string;
  /** Credenziale di sola lettura di questo telefono: "Bearer <dispositivo>.<token>". */
  token: string;
  /** Chiave dello studio (32 byte, base64) per decifrare i file. */
  chiave: string;
}

const esadecimale = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** "a1b2…/c3d4….pdf": impronta di pratica e documento, più l'estensione vera. */
export function chiaveFile(praticaId: string, documentoId: string, percorso: string): string {
  const h = (s: string) => esadecimale(sha256(utf8(s))).slice(0, 24);
  return `${h(`pratica:${praticaId}`)}/${h(`documento:${praticaId}/${documentoId}`)}${estensione(percorso)}`;
}

/** Estensione in minuscolo, ripulita (".pdf"); "" se manca. */
export function estensione(percorso: string): string {
  const nome = percorso.split(/[\\/]/).pop() ?? '';
  const i = nome.lastIndexOf('.');
  if (i <= 0) return '';
  return nome.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
}

/** Il testo già estratto dal computer (PDF, OCR, Word…), per l'assistente sul server. */
export function chiaveTesto(praticaId: string, documentoId: string): string {
  return chiaveFile(praticaId, `${documentoId}#testo`, 'testo.json');
}

/**
 * Il "pacchetto" dello studio sul server privato: quello che serve
 * all'assistente di riserva per lavorare a computer spento. Cifrato con la
 * chiave dello studio come i file (il server lo legge solo quando un
 * dispositivo gli dà la chiave, e solo in memoria).
 */
export interface PacchettoStudio {
  v: 1;
  creatoIl: string;
  studio: { nome: string; avvocato: string } | null;
  pratiche: Array<{ id: string; nome: string; cliente: string; controparte?: string; ambito: string; note?: string }>;
  documenti: Record<string, Array<{ id: string; nome: string; tipo: string; cartella: string; pagine?: number; data: string; percorso?: string }>>;
  /** Memoria della pratica (fatti e schede dei documenti), per id della pratica. */
  memorie: Record<string, unknown>;
  /** Credenziali DeJure dell'avvocato, se ha collegato DeJure. */
  dejure: { utente: string; password: string } | null;
}

export const FORMATO_CHIAVE = /^[0-9a-f]{24}\/[0-9a-f]{24}(\.[a-z0-9]{1,7})?$/;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.eml': 'message/rfc822',
  '.msg': 'application/vnd.ms-outlook',
  '.p7m': 'application/pkcs7-mime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

export function mimeDi(percorso: string): string {
  return MIME[estensione(percorso)] ?? 'application/octet-stream';
}

// ─── Formato JRA1 (vedi src/core/cifraturaArchivio.ts) ──────────────────────
const MAGIA = [0x4a, 0x52, 0x41, 0x31]; // "JRA1"
const SALE = 16;
const TAG = 16;
const BLOCCO = 1024 * 1024;
const INTESTAZIONE = MAGIA.length + SALE;

function nonce(numero: number, ultimo: boolean): Uint8Array {
  const n = new Uint8Array(12);
  // Come writeUIntBE(numero, 5, 6): 6 byte big-endian dalla posizione 5.
  let x = numero;
  for (let i = 10; i >= 5; i--) {
    n[i] = x % 256;
    x = Math.floor(x / 256);
  }
  n[11] = ultimo ? 1 : 0;
  return n;
}

/** Decifra un file intero; errore se non è di JarAI, è alterato o troncato. */
export function decifraArchivio(chiave: Uint8Array, dati: Uint8Array): Uint8Array {
  if (chiave.length !== 32) throw new Error('chiave dello studio non valida');
  if (dati.length < INTESTAZIONE + TAG || MAGIA.some((b, i) => dati[i] !== b)) throw new Error('non è un file cifrato di JarAI');
  const intestazione = dati.subarray(0, INTESTAZIONE);
  const k = hkdf(sha256, chiave, intestazione.subarray(MAGIA.length), utf8('jarai-archivio-v1'), 32);
  const corpo = dati.subarray(INTESTAZIONE);
  const PIENO = BLOCCO + TAG;
  const blocchi = Math.max(1, Math.ceil(corpo.length / PIENO));
  const out = new Uint8Array(corpo.length - blocchi * TAG);
  let scritti = 0;
  try {
    for (let i = 0; i < blocchi; i++) {
      const ultimo = i === blocchi - 1;
      const blocco = corpo.subarray(i * PIENO, ultimo ? corpo.length : (i + 1) * PIENO);
      const chiaro = gcm(k, nonce(i, ultimo), intestazione).decrypt(blocco);
      out.set(chiaro, scritti);
      scritti += chiaro.length;
    }
  } catch {
    throw new Error('file cifrato alterato o incompleto');
  }
  return out;
}
