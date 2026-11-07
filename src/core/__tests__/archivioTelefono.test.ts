import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cifra } from '../cifraturaArchivio';
import { chiaveFile, decifraArchivio, estensione, FORMATO_CHIAVE, mimeDi } from '../../shared/archivio';

async function cifraTutto(chiave: Buffer, dati: Buffer): Promise<Buffer> {
  const pezzi: Buffer[] = [];
  // A pezzi irregolari, come arriva da un file vero.
  const sorgente = Readable.from((function* () {
    for (let i = 0; i < dati.length; i += 300_001) yield dati.subarray(i, i + 300_001);
  })());
  for await (const p of sorgente.pipe(cifra(chiave))) pezzi.push(p as Buffer);
  return Buffer.concat(pezzi);
}

describe('archivio sul telefono', () => {
  const chiave = randomBytes(32);

  it.each([0, 10, 1024 * 1024, 1024 * 1024 + 1, Math.floor(2.5 * 1024 * 1024)])('legge quello che il desktop cifra (%i byte)', async (n) => {
    const dati = randomBytes(n);
    const cifrato = await cifraTutto(chiave, dati);
    expect(Buffer.from(decifraArchivio(chiave, cifrato)).equals(dati)).toBe(true);
  });

  it('rifiuta file alterati, troncati, in chiaro o con un\'altra chiave', async () => {
    const cifrato = await cifraTutto(chiave, randomBytes(2 * 1024 * 1024 + 7));
    const alterato = Buffer.from(cifrato);
    alterato[100] ^= 1;
    expect(() => decifraArchivio(chiave, alterato)).toThrow('alterato');
    // Tolto l'ultimo blocco: il penultimo non è segnato come ultimo.
    expect(() => decifraArchivio(chiave, cifrato.subarray(0, 20 + 2 * (1024 * 1024 + 16)))).toThrow('alterato');
    expect(() => decifraArchivio(chiave, Buffer.from('%PDF-1.7 in chiaro, abbastanza lungo'))).toThrow('non è un file cifrato');
    expect(() => decifraArchivio(randomBytes(32), cifrato)).toThrow('alterato');
  });

  it('chiave del file: stessa formula di prima (i file già sul server restano validi)', () => {
    const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
    expect(chiaveFile('p1', 'd 1', '/Studio/Rossi/Contratto Firmato.PDF')).toBe(`${h('pratica:p1')}/${h('documento:p1/d 1')}.pdf`);
    expect(chiaveFile('p1', 'd1', 'senza-estensione')).toMatch(FORMATO_CHIAVE);
    expect(chiaveFile('pàtica', 'dòc', 'C:\\Dati\\nota.txt')).toBe(`${h('pratica:pàtica')}/${h('documento:pàtica/dòc')}.txt`);
  });

  it('estensione e tipo di file', () => {
    expect(estensione('/a/b.c/file')).toBe('');
    expect(estensione('.nascosto')).toBe('');
    expect(mimeDi('Atto.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeDi('x.boh')).toBe('application/octet-stream');
  });
});
