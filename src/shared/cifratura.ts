// Cifratura end-to-end tra desktop e telefono (spec §9.4). Il relay inoltra
// solo testo cifrato: non conosce le chiavi e non può leggere né alterare
// niente senza che il destinatario se ne accorga.
//
// - Chiavi: ECDH P-256 (supportato ovunque: Node, Electron, browser, e in
//   React Native con un modulo WebCrypto). Desktop e telefono hanno ognuno
//   la sua coppia; le pubbliche si scambiano con il QR e con l'abbinamento.
// - Dal segreto comune, HKDF-SHA256 ricava due chiavi AES-GCM 256, una per
//   direzione, legate a quel computer e a quel telefono (sale).
// - Ogni messaggio: IV casuale di 12 byte + testo cifrato con tag.
//
// Solo WebCrypto standard (globalThis.crypto.subtle).

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const VERSO_DESKTOP = 'jarai v1 telefono→desktop';
const VERSO_TELEFONO = 'jarai v1 desktop→telefono';

export interface CoppiaDiChiavi {
  /** Chiave pubblica grezza (65 byte) in base64url: va nel QR. */
  pubblica: string;
  privata: CryptoKey;
}

export interface ChiaviSessione {
  versoDesktop: CryptoKey;
  versoTelefono: CryptoKey;
}

const subtle = () => globalThis.crypto.subtle;

export async function generaCoppia(): Promise<CoppiaDiChiavi> {
  const coppia = (await subtle().generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  return { pubblica: await esportaPubblica(coppia.publicKey), privata: coppia.privateKey };
}

async function esportaPubblica(chiave: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await subtle().exportKey('raw', chiave)));
}

/** Per conservarla (cifrata) sul dispositivo. */
export async function esportaPrivata(privata: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', privata);
}

export async function importaPrivata(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, ECDH, true, ['deriveBits']);
}

/** Pubblica ricavata dalla privata salvata (per non doverla conservare a parte). */
export async function pubblicaDaPrivata(jwk: JsonWebKey): Promise<string> {
  const { d: _d, key_ops: _o, ...pubblica } = jwk;
  const chiave = await subtle().importKey('jwk', { ...pubblica, key_ops: [] }, ECDH, true, []);
  return esportaPubblica(chiave);
}

/**
 * Le stesse due chiavi su entrambi i lati: il desktop chiama con la sua
 * privata e la pubblica del telefono, il telefono con la sua e quella del
 * desktop. sale = identificativi di computer e telefono.
 */
export async function derivaChiavi(privata: CryptoKey, pubblicaAltro: string, sale: string): Promise<ChiaviSessione> {
  const altro = await subtle().importKey('raw', daBase64url(pubblicaAltro), ECDH, false, []);
  const segreto = await subtle().deriveBits({ name: 'ECDH', public: altro }, privata, 256);
  const base = await subtle().importKey('raw', segreto, 'HKDF', false, ['deriveKey']);
  const deriva = (info: string) =>
    subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(sale), info: new TextEncoder().encode(info) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  return { versoDesktop: await deriva(VERSO_DESKTOP), versoTelefono: await deriva(VERSO_TELEFONO) };
}

export async function cifra(chiave: CryptoKey, testo: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cifrato = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, chiave, new TextEncoder().encode(testo)));
  const tutto = new Uint8Array(iv.length + cifrato.length);
  tutto.set(iv);
  tutto.set(cifrato, iv.length);
  return base64url(tutto);
}

/** Lancia un errore se il messaggio è stato alterato o la chiave è sbagliata. */
export async function decifra(chiave: CryptoKey, dati: string): Promise<string> {
  const tutto = daBase64url(dati);
  const chiaro = await subtle().decrypt({ name: 'AES-GCM', iv: tutto.slice(0, 12) }, chiave, tutto.slice(12));
  return new TextDecoder().decode(chiaro);
}

export function casuale(byte = 32): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(byte)));
}

export async function impronta(testo: string): Promise<string> {
  return base64url(new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(testo))));
}

function base64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function daBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
