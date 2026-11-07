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

describe('telefoni sul server privato', () => {
  const TEL = 'telefono_di_giulia_123';
  const TOKEN = 'T'.repeat(43);

  it('un telefono registrato scarica i file cifrati, e solo quelli; revocato non più', async () => {
    const { aggiungi, sync } = await prepara();
    const { chiave } = aggiungi('p1', 'd1', 'Contratto.pdf', 'contenuto riservato');
    await sync().sincronizza();
    const url = aperti.at(-1)!.address() as AddressInfo;
    const base = `http://127.0.0.1:${url.port}`;
    const cliente = new ClienteArchivio(base, LICENZA);
    const scarica = (k: string, token = `${TEL}.${TOKEN}`) => fetch(`${base}/telefono/file/${k}`, { headers: { authorization: `Bearer ${token}` } });

    expect((await scarica(chiave)).status).toBe(401); // non ancora registrato
    await cliente.registraTelefono(TEL, TOKEN);
    const r = await scarica(chiave);
    expect(r.status).toBe(200);
    const cifrato = Buffer.from(await r.arrayBuffer());
    expect(cifrato.subarray(0, 4).toString()).toBe('JRA1');
    expect((await passa(decifra, cifrato)).toString()).toBe('contenuto riservato');

    expect((await scarica(chiave, `${TEL}.${'X'.repeat(43)}`)).status).toBe(401);
    expect((await scarica('a'.repeat(24) + '/' + 'b'.repeat(24) + '.pdf')).status).toBe(404);
    // Il token del telefono non apre le operazioni del desktop.
    expect((await fetch(`${base}/sync/elenco`, { headers: { authorization: `Bearer ${TEL}.${TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${base}/telefono/file/${chiave}`, { method: 'DELETE', headers: { authorization: `Bearer ${TEL}.${TOKEN}` } })).status).toBe(405);

    await cliente.revocaTelefono(TEL);
    expect((await scarica(chiave)).status).toBe(401);
  });

  it('telefoniAttivi toglie i telefoni revocati mentre il server non rispondeva', async () => {
    const { aggiungi, sync } = await prepara();
    const { chiave } = aggiungi('p1', 'd1', 'a.pdf', 'x');
    await sync().sincronizza();
    const base = `http://127.0.0.1:${(aperti.at(-1)!.address() as AddressInfo).port}`;
    const cliente = new ClienteArchivio(base, LICENZA);
    await cliente.registraTelefono(TEL, TOKEN);
    await cliente.registraTelefono('altro_telefono_45678', TOKEN);
    await cliente.telefoniAttivi(['altro_telefono_45678']);
    const stato = (id: string) => fetch(`${base}/telefono/file/${chiave}`, { headers: { authorization: `Bearer ${id}.${TOKEN}` } }).then((r) => r.status);
    expect(await stato(TEL)).toBe(401);
    expect(await stato('altro_telefono_45678')).toBe(200);
  });
});

describe('telefono → server privato, da capo a fondo', () => {
  it('il computer dà l\'accesso al telefono collegato, che scarica e decifra da solo', async () => {
    const { aggiungi, sync } = await prepara();
    aggiungi('pratica-1', 'doc-1', 'Contratto.pdf', '%PDF-1.7 contratto riservato');
    await sync().sincronizza();
    const base = `http://127.0.0.1:${(aperti.at(-1)!.address() as AddressInfo).port}`;

    // Lato computer: come src/main/serverPrivato.ts accessoTelefono.
    const { Host } = await import('../host');
    const { apriDatabase } = await import('../db');
    const { MotoreFinto } = await import('./motoreFinto');
    const { casuale } = await import('../../shared/cifratura');
    const host = new Host(apriDatabase(':memory:'), new MotoreFinto());
    const archivio = new ClienteArchivio(base, LICENZA);
    host.impostaAccessoServer(async (id) => {
      const token = casuale(32);
      await archivio.registraTelefono(id, token);
      return { url: base, token: `${id}.${token}`, chiave: CHIAVE.toString('base64') };
    });

    // Lato telefono: come jarai-app/src/server.ts.
    const TEL = 'abcdefghijklmnopqrstuv';
    const r = await host.gestisciBusta({ v: 1, tipo: 'richiesta', id: 'x', richiesta: { tipo: 'server.accesso' } }, { dispositivoId: TEL });
    const accesso = (r as { esito: { dati: { accesso: { url: string; token: string; chiave: string } } } }).esito.dati.accesso;
    const { chiaveFile: chiaveCondivisa, decifraArchivio } = await import('../../shared/archivio');
    const k = chiaveCondivisa('pratica-1', 'doc-1', '/qualsiasi/cartella/Contratto.pdf');
    const risposta = await fetch(`${accesso.url}/telefono/file/${k}`, { headers: { authorization: `Bearer ${accesso.token}` } });
    expect(risposta.status).toBe(200);
    const chiaro = decifraArchivio(Buffer.from(accesso.chiave, 'base64'), new Uint8Array(await risposta.arrayBuffer()));
    expect(Buffer.from(chiaro).toString()).toBe('%PDF-1.7 contratto riservato');

    // Una nuova richiesta rinnova il token: quello vecchio non vale più.
    await host.gestisciBusta({ v: 1, tipo: 'richiesta', id: 'y', richiesta: { tipo: 'server.accesso' } }, { dispositivoId: TEL });
    expect((await fetch(`${accesso.url}/telefono/file/${k}`, { headers: { authorization: `Bearer ${accesso.token}` } })).status).toBe(401);
  });
});

describe('pacchetto e testi per l\'assistente di riserva', () => {
  it('i testi già estratti vanno accanto ai file; il pacchetto arriva cifrato', async () => {
    const { apriDatabase } = await import('../db');
    const { migraResto } = await import('../migrazioneJson');
    const { cifraTutto } = await import('../cifraturaArchivio');
    const { costruisciPacchetto, testiDaSincronizzare } = await import('../sincronizzazione');
    const { chiaveTesto, decifraArchivio } = await import('../../shared/archivio');
    const { server, archivio } = await prepara();
    const base = `http://127.0.0.1:${(aperti.at(-1)!.address() as AddressInfo).port}`;

    const studio = mkdtempSync(join(tmpdir(), 'jarai-studio-'));
    const pdf = join(studio, 'Contratto.pdf');
    writeFileSync(pdf, '%PDF');
    const indice = join(studio, 'indice.json');
    writeFileSync(indice, JSON.stringify({ testo: '[Pagina 1]\nArt. 1 - Oggetto', indicizzatoIl: 'ieri' }));
    const db = apriDatabase(':memory:');
    migraResto(db, {
      pratiche: [{ id: 'p1', nome: 'Rossi c. Bianchi', cliente: 'Mario Rossi', ambito: 'Civile', documenti: 2, aggiornataIl: 'oggi', cartellaPercorso: studio }],
      documenti: {
        p1: [
          { id: 'd1', nome: 'Contratto', tipo: 'Contratto', data: '2026-03-03', cartella: 'Contratti', percorso: pdf },
          { id: 'd2', nome: 'Non ancora letto', tipo: 'Altro', data: '2026-03-04', cartella: 'Altro', percorso: join(studio, 'x.pdf') },
        ],
      },
    } as never);

    const testi = await testiDaSincronizzare(db, async (p) => (p === pdf ? indice : null));
    expect(testi).toEqual([{ chiave: chiaveTesto('p1', 'd1'), percorso: indice }]);

    const p = costruisciPacchetto(db, { memorie: { p1: { fatti: {}, schede: {} } }, dejure: { utente: 'avv', password: 'segreta' }, ora: 'adesso' });
    expect(p.pratiche.map((x) => x.nome)).toEqual(['Rossi c. Bianchi']);
    expect(p.documenti.p1.map((d) => d.id)).toEqual(['d1', 'd2']);
    await new ClienteArchivio(base, LICENZA).caricaPacchetto(await cifraTutto(CHIAVE, Buffer.from(JSON.stringify(p))));
    const sulServer = readFileSync(archivio.percorsoPacchetto());
    expect(sulServer.includes(Buffer.from('segreta'))).toBe(false);
    expect(sulServer.includes(Buffer.from('Rossi'))).toBe(false);
    expect(JSON.parse(Buffer.from(decifraArchivio(CHIAVE, sulServer)).toString()).dejure.password).toBe('segreta');
    expect(existsSync(join(server, 'pacchetto.jra'))).toBe(true);

    // Un pacchetto in chiaro viene rifiutato.
    const r = await fetch(`${base}/sync/pacchetto`, { method: 'PUT', headers: { authorization: `Bearer ${LICENZA}` }, body: JSON.stringify(p) });
    expect(r.status).toBe(400);
  });
});
