import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Archivio } from '../../server/archivio';
import { BLOCCO, cifra, decifra, dimensioneCifrata } from '../cifraturaArchivio';
import { chiaveFile, ClienteArchivio, FORMATO_CHIAVE, Sincronizzatore, type StatoSincronizzazione } from '../sincronizzazione';

const LICENZA = 'jarai_prova';
const CHIAVE = randomBytes(32);

async function passa(t: (k: Uint8Array) => NodeJS.ReadWriteStream, dati: Buffer, k: Uint8Array = CHIAVE): Promise<Buffer> {
  const pezzi: Buffer[] = [];
  await pipeline(Readable.from([dati]), t(k), async function* (s) {
    for await (const p of s) pezzi.push(p as Buffer);
  });
  return Buffer.concat(pezzi);
}
/** Il contenuto in chiaro di un file sul server. */
const inChiaro = (percorso: string) => passa(decifra, readFileSync(percorso));
const aperti: Server[] = [];
afterEach(() => {
  for (const s of aperti.splice(0)) s.close();
});

async function prepara(limite: number | null = null) {
  const studio = mkdtempSync(join(tmpdir(), 'jarai-studio-'));
  const server = mkdtempSync(join(tmpdir(), 'jarai-server-'));
  const archivio = new Archivio({ db: new DatabaseSync(':memory:'), cartella: server, licenza: LICENZA, limite: async () => limite });
  const http = createServer((req, res) => void archivio.gestisci(req, res));
  aperti.push(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const locali: Array<{ chiave: string; percorso: string }> = [];
  const stati: StatoSincronizzazione[] = [];
  const aggiungi = (pratica: string, doc: string, nome: string, contenuto: string | Buffer) => {
    const percorso = join(studio, nome);
    writeFileSync(percorso, contenuto);
    const chiave = chiaveFile(pratica, doc, percorso);
    if (!locali.some((l) => l.chiave === chiave)) locali.push({ chiave, percorso });
    return { chiave, percorso };
  };
  const sync = (licenza = LICENZA) =>
    new Sincronizzatore({ cliente: new ClienteArchivio(url, licenza), chiave: CHIAVE, locali: () => [...locali], onStato: (s) => stati.push(s) });
  return { studio, server, archivio, locali, stati, aggiungi, sync };
}

describe('chiaveFile', () => {
  it('non rivela nomi e tiene l\'estensione', () => {
    const k = chiaveFile('Rossi c. Bianchi', 'Contratto', '/Studio/Rossi/Contratto di fornitura.PDF');
    expect(k).toMatch(FORMATO_CHIAVE);
    expect(k.endsWith('.pdf')).toBe(true);
    expect(k).not.toMatch(/rossi|contratto/i);
    expect(chiaveFile('p', 'd', 'a.pdf')).toBe(chiaveFile('p', 'd', 'b.pdf'));
  });
});

describe('sincronizzazione desktop → server privato', () => {
  it('carica, aggiorna i file cambiati e cancella quelli tolti in studio', async () => {
    const t = await prepara();
    const a = t.aggiungi('p1', 'd1', 'Contratto.pdf', 'primo contenuto');
    const b = t.aggiungi('p1', 'd2', 'Foto.png', Buffer.alloc(300_000, 7));
    const s = t.sync();
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'sincronizzata', file: 2, usati: dimensioneCifrata(15) + dimensioneCifrata(300_000), mancanti: 0 });
    expect(t.stati.some((x) => x.tipo === 'in_corso')).toBe(true);
    // Sul server è cifrato: non si legge senza la chiave dello studio.
    expect(readFileSync(join(t.server, a.chiave)).includes('primo contenuto')).toBe(false);
    expect((await inChiaro(join(t.server, a.chiave))).toString()).toBe('primo contenuto');

    // Modificato in studio: si ricarica solo quello.
    writeFileSync(a.percorso, 'secondo contenuto, più lungo');
    t.stati.length = 0;
    await s.sincronizza();
    const giro = t.stati.find((x) => x.tipo === 'in_corso');
    expect(giro).toMatchObject({ totale: 1 });
    expect((await inChiaro(join(t.server, a.chiave))).toString()).toBe('secondo contenuto, più lungo');

    // Tolto dalla pratica: sparisce dal server.
    t.locali.splice(t.locali.findIndex((l) => l.chiave === b.chiave), 1);
    await s.sincronizza();
    expect(existsSync(join(t.server, b.chiave))).toBe(false);
    expect(s.stato).toMatchObject({ tipo: 'sincronizzata', file: 1 });

    // Niente cambiato: nessun caricamento.
    t.stati.length = 0;
    await s.sincronizza();
    expect(t.stati.map((x) => x.tipo)).toEqual(['sincronizzata']);
  });

  it('un file spostato sul desktop non blocca gli altri', async () => {
    const t = await prepara();
    t.aggiungi('p1', 'd1', 'A.pdf', 'a');
    const via = t.aggiungi('p1', 'd2', 'B.pdf', 'b');
    rmSync(via.percorso);
    const s = t.sync();
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'sincronizzata', file: 1, mancanti: 1 });
  });

  it('rispetta il limite di spazio e lo dice', async () => {
    const t = await prepara(1000);
    t.aggiungi('p1', 'd1', 'Piccolo.pdf', Buffer.alloc(560));
    t.aggiungi('p1', 'd2', 'Grande.pdf', Buffer.alloc(560));
    const s = t.sync();
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'errore', usati: 0, limite: 1000 });
    expect((s.stato as { messaggio: string }).messaggio).toMatch(/Spazio esaurito/);
    expect(t.archivio.usati()).toBe(dimensioneCifrata(560));
  });

  it('rifiuta una licenza sbagliata', async () => {
    const t = await prepara();
    t.aggiungi('p1', 'd1', 'A.pdf', 'a');
    const s = t.sync('jarai_altro');
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'errore', messaggio: 'Il server privato non riconosce la licenza di questo studio.' });
  });

  it('il server rifiuta un file non cifrato', async () => {
    const t = await prepara();
    const k = chiaveFile('p', 'd', 'x.pdf');
    const r = await fetch(`http://127.0.0.1:${(aperti[0].address() as AddressInfo).port}/sync/file/${k}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${LICENZA}`, 'x-impronta': '0'.repeat(64) },
      body: 'contenuto in chiaro',
    });
    expect(r.status).toBe(400);
    expect(t.archivio.usati()).toBe(0);
    expect(existsSync(join(t.server, k))).toBe(false);
  });

  it('non accetta chiavi che escono dalla cartella', async () => {
    const t = await prepara();
    const porta = (aperti[0].address() as AddressInfo).port;
    for (const k of ['..%2F..%2Fetc%2Fpasswd', 'abc', `${'a'.repeat(24)}/../x`]) {
      const r = await fetch(`http://127.0.0.1:${porta}/sync/file/${k}`, { method: 'DELETE', headers: { authorization: `Bearer ${LICENZA}` } });
      expect(r.status).toBe(404);
    }
    expect(t.archivio.usati()).toBe(0);
  });
});

describe('cifratura dei file per il server', () => {
  it('cifra e decifra file di ogni dimensione, con la dimensione prevista', async () => {
    for (const n of [0, 1, 1000, BLOCCO - 1, BLOCCO, BLOCCO + 1, 2 * BLOCCO + 12345]) {
      const dati = randomBytes(n);
      const c = await passa(cifra, dati);
      expect(c.length).toBe(dimensioneCifrata(n));
      expect((await passa(decifra, c)).equals(dati)).toBe(true);
    }
  });

  it('lo stesso file cifrato due volte non è uguale (sale casuale)', async () => {
    const dati = Buffer.from('stesso contenuto');
    expect((await passa(cifra, dati)).equals(await passa(cifra, dati))).toBe(false);
  });

  it('scopre file alterati, troncati o con la chiave sbagliata', async () => {
    const dati = randomBytes(BLOCCO + 500);
    const c = await passa(cifra, dati);
    const alterato = Buffer.from(c);
    alterato[100] ^= 1;
    await expect(passa(decifra, alterato)).rejects.toThrow();
    // Tolto l'ultimo blocco: quello rimasto non è segnato come ultimo.
    await expect(passa(decifra, c.subarray(0, 20 + BLOCCO + 16))).rejects.toThrow();
    await expect(passa(decifra, c, randomBytes(32))).rejects.toThrow();
  });
});
