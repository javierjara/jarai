import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Archivio } from '../../server/archivio';
import { chiaveFile, ClienteArchivio, FORMATO_CHIAVE, Sincronizzatore, type StatoSincronizzazione } from '../sincronizzazione';

const LICENZA = 'jarai_prova';
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
    new Sincronizzatore({ cliente: new ClienteArchivio(url, licenza), locali: () => [...locali], onStato: (s) => stati.push(s) });
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
    expect(s.stato).toMatchObject({ tipo: 'sincronizzata', file: 2, usati: 15 + 300_000, mancanti: 0 });
    expect(t.stati.some((x) => x.tipo === 'in_corso')).toBe(true);
    expect(readFileSync(join(t.server, a.chiave), 'utf8')).toBe('primo contenuto');

    // Modificato in studio: si ricarica solo quello.
    writeFileSync(a.percorso, 'secondo contenuto, più lungo');
    t.stati.length = 0;
    await s.sincronizza();
    const giro = t.stati.find((x) => x.tipo === 'in_corso');
    expect(giro).toMatchObject({ totale: 1 });
    expect(readFileSync(join(t.server, a.chiave), 'utf8')).toBe('secondo contenuto, più lungo');

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
    t.aggiungi('p1', 'd1', 'Piccolo.pdf', Buffer.alloc(600));
    t.aggiungi('p1', 'd2', 'Grande.pdf', Buffer.alloc(600));
    const s = t.sync();
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'errore', usati: 0, limite: 1000 });
    expect((s.stato as { messaggio: string }).messaggio).toMatch(/Spazio esaurito/);
    expect(t.archivio.usati()).toBe(600);
  });

  it('rifiuta una licenza sbagliata', async () => {
    const t = await prepara();
    t.aggiungi('p1', 'd1', 'A.pdf', 'a');
    const s = t.sync('jarai_altro');
    await s.sincronizza();
    expect(s.stato).toMatchObject({ tipo: 'errore', messaggio: 'Il server privato non riconosce la licenza di questo studio.' });
  });

  it('il server scarta un file arrivato diverso dall\'impronta dichiarata', async () => {
    const t = await prepara();
    const k = chiaveFile('p', 'd', 'x.pdf');
    const r = await fetch(`http://127.0.0.1:${(aperti[0].address() as AddressInfo).port}/sync/file/${k}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${LICENZA}`, 'x-sha256': '0'.repeat(64) },
      body: 'contenuto',
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
