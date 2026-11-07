import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Archivio } from '../../server/archivio';
import { collegaCanaleTelefono } from '../../server/canaleTelefono';
import { StudioServer, type ContestoMotore } from '../../server/studio';
import { canaleServer } from '../../shared/canaleServer';
import { ClienteRemoto } from '../../shared/clienteRemoto';
import { chiaveTesto, decifraArchivio, type AccessoServer, type PacchettoStudio } from '../../shared/archivio';
import { cifraTutto } from '../cifraturaArchivio';
import { ClienteArchivio } from '../sincronizzazione';
import { MotoreFinto } from './motoreFinto';

// L'assistente di riserva sul server privato, da capo a fondo, con un
// motore finto al posto di Claude: il telefono si collega con token e
// chiave, chiede, riceve la risposta; le conversazioni restano cifrate sul
// server, sopravvivono a un riavvio e il computer le importa.

const LICENZA = 'jarai_prova';
const CHIAVE = randomBytes(32);
const TEL = 'telefono_di_giulia_00';
const aperti: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of aperti.splice(0).reverse()) await f();
});

async function finche(condizione: () => boolean, ms = 3000): Promise<void> {
  const fine = Date.now() + ms;
  while (!condizione()) {
    if (Date.now() > fine) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PACCHETTO: PacchettoStudio = {
  v: 1,
  creatoIl: 'oggi',
  studio: { nome: 'Studio Molfino', avvocato: 'Avv. Molfino' },
  pratiche: [{ id: 'p1', nome: 'Rossi c. Bianchi', cliente: 'Mario Rossi', ambito: 'Civile' }],
  documenti: { p1: [{ id: 'd1', nome: 'Contratto.pdf', tipo: 'Contratto', cartella: 'Contratti', data: '2026-03-03', percorso: '/x/Contratto.pdf' }] },
  memorie: { p1: { fatti: { giudice: { valore: 'Tribunale di Genova' } }, schede: {} } },
};

async function prepara() {
  const cartellaPratiche = mkdtempSync(join(tmpdir(), 'jarai-pratiche-'));
  const cartellaDati = mkdtempSync(join(tmpdir(), 'jarai-dati-'));
  let motore = new MotoreFinto();
  let contesto: ContestoMotore | null = null;
  const nuovoStudio = () =>
    new StudioServer({
      cartellaPratiche,
      cartellaDati,
      dimenticaDopoMs: 60_000,
      creaMotore: (c) => {
        contesto = c;
        motore = new MotoreFinto();
        return motore;
      },
    });
  let studio = nuovoStudio();
  const archivio = new Archivio({
    db: new DatabaseSync(':memory:'),
    cartella: cartellaPratiche,
    licenza: LICENZA,
    limite: async () => null,
    conversazioni: { elenco: () => studio.conversazioniSalvate(), leggi: (id) => studio.leggiConversazione(id), elimina: (id) => studio.eliminaConversazione(id) },
  });
  const http: Server = createServer((req, res) => void archivio.gestisci(req, res));
  const canale = collegaCanaleTelefono(http, { telefonoDaToken: (t) => archivio.telefonoDaToken(t), studio: { apri: (k: Uint8Array) => studio.apri(k), entra: () => studio.entra(), esce: () => studio.esce() } as never });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  aperti.push(() => new Promise((r) => http.close(r)), () => canale.chiudi());
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // Il computer dello studio: pacchetto, testo del contratto, telefono registrato.
  const desktop = new ClienteArchivio(url, LICENZA);
  await desktop.caricaPacchetto(await cifraTutto(CHIAVE, Buffer.from(JSON.stringify(PACCHETTO))));
  writeFileSync(join(cartellaPratiche, 'testo.tmp'), '');
  const k = chiaveTesto('p1', 'd1');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cartellaPratiche, k.split('/')[0]), { recursive: true });
  writeFileSync(join(cartellaPratiche, k), await cifraTutto(CHIAVE, Buffer.from(JSON.stringify({ testo: '[Pagina 1]\nArt. 2 - Corrispettivo: euro 12.400' }))));
  await desktop.registraTelefono(TEL, 'T'.repeat(43));
  const accesso: AccessoServer = { url, token: `${TEL}.${'T'.repeat(43)}`, chiave: CHIAVE.toString('base64') };

  const telefono = async (a: AccessoServer = accesso) => {
    const c = new ClienteRemoto({ canale: () => canaleServer(a), attesaMassimaMs: 50 });
    aperti.push(() => c.chiudi());
    await c.connetti();
    return c;
  };
  return {
    url,
    desktop,
    accesso,
    cartellaDati,
    telefono,
    motore: () => motore,
    contesto: () => contesto!,
    studio: () => studio,
    riavvia: async () => {
      await studio.dimentica(true);
      studio = nuovoStudio();
    },
  };
}

describe('assistente di riserva sul server privato', () => {
  it('il telefono chiede e riceve la risposta; i testi si decifrano solo con la chiave', async () => {
    const s = await prepara();
    const t = await s.telefono();
    await t.comando({ tipo: 'conversazione.crea', argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: 'p1', titolo: '', procedura: null, qualita: 'Standard' } });
    await t.caricaConversazione('c1');
    await t.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'c1', testo: 'Quanto è il corrispettivo?', qualita: 'Standard' } });

    // Quello che vede il motore: documenti e testo decifrato della pratica.
    const fonti = s.contesto().fonti('p1', PACCHETTO.documenti.p1);
    expect(await fonti.testo('d1')).toContain('12.400');
    expect(fonti.memoria).toMatchObject({ fatti: { giudice: { valore: 'Tribunale di Genova' } } });
    expect(s.motore().richieste.at(-1)).toMatchObject({ praticaId: 'p1', documenti: [{ id: 'd1' }] });

    s.motore().emetti('c1', { tipo: 'delta', testo: 'Euro ' });
    await finche(() => t.conversazione('c1')?.turno?.testoParziale === 'Euro ');
    s.motore().emetti('c1', { tipo: 'completato', testo: 'Euro 12.400 (Contratto.pdf, p. 1).' });
    await s.motore().finisci('c1');
    await finche(() => t.conversazione('c1')?.stato === 'completata');
    expect(t.conversazione('c1')!.messaggi.map((m) => m.testo)).toEqual(['Quanto è il corrispettivo?', 'Euro 12.400 (Contratto.pdf, p. 1).']);
    expect(t.conversazione('c1')!.messaggi[0].dispositivoId).toBe(TEL);
  });

  it('token sbagliato: rifiutato per sempre; chiave sbagliata: non pronto', async () => {
    const s = await prepara();
    await expect(s.telefono({ ...s.accesso, token: `${TEL}.${'X'.repeat(43)}` })).rejects.toThrow('Non autorizzato.');
    const c = new ClienteRemoto({ canale: () => canaleServer({ ...s.accesso, chiave: randomBytes(32).toString('base64') }) });
    await expect(c.connetti()).rejects.toThrow();
    expect(s.studio().attivo).toBe(false);
  });

  it('le conversazioni restano cifrate sul server, sopravvivono a un riavvio, e i seq non tornano indietro', async () => {
    const s = await prepara();
    const t = await s.telefono();
    await t.comando({ tipo: 'conversazione.crea', argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: 'p1', titolo: 'Corrispettivo', procedura: null, qualita: 'Standard' } });
    await t.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'c1', testo: 'Domanda riservata su Rossi', qualita: 'Standard' } });
    s.motore().emetti('c1', { tipo: 'completato', testo: 'Risposta riservata.' });
    await s.motore().finisci('c1');
    await finche(() => t.elenco.conversazioni.c1?.stato === 'completata');
    const seqPrima = t.elenco.ultimoSeq;
    t.chiudi();
    await s.riavvia();

    const file = readdirSync(join(s.cartellaDati, 'conversazioni'));
    expect(file).toEqual(['c1.jra']);
    const cifrato = readFileSync(join(s.cartellaDati, 'conversazioni', 'c1.jra'));
    expect(cifrato.includes(Buffer.from('Rossi'))).toBe(false);

    const t2 = await s.telefono();
    expect((await t2.caricaConversazione('c1'))!.messaggi.map((m) => m.testo)).toEqual(['Domanda riservata su Rossi', 'Risposta riservata.']);
    await t2.comando({ tipo: 'conversazione.crea', argomenti: { conversazioneId: 'c2', modalita: 'pratica', praticaId: null, titolo: 'Altra', procedura: null, qualita: 'Standard' } });
    await finche(() => !!t2.elenco.conversazioni.c2);
    expect(t2.elenco.ultimoSeq).toBeGreaterThan(seqPrima);
  });

  it('il computer importa le conversazioni (le decifra lui) e il server le toglie', async () => {
    const s = await prepara();
    const t = await s.telefono();
    await t.comando({ tipo: 'conversazione.crea', argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: 'p1', titolo: 'Dal telefono', procedura: null, qualita: 'Standard' } });
    await finche(() => !!t.elenco.conversazioni.c1);
    await s.studio().salva();
    t.chiudi();

    const auth = { authorization: `Bearer ${LICENZA}` };
    const elenco = (await (await fetch(`${s.url}/sync/conversazioni`, { headers: auth })).json()) as { conversazioni: Array<{ id: string; inCorso: boolean }> };
    expect(elenco.conversazioni.map((c) => [c.id, c.inCorso])).toEqual([['c1', false]]);
    const cifrato = new Uint8Array(await (await fetch(`${s.url}/sync/conversazioni/c1`, { headers: auth })).arrayBuffer());
    const { eventi } = JSON.parse(Buffer.from(decifraArchivio(CHIAVE, cifrato)).toString()) as { eventi: Array<{ tipo: string }> };
    expect(eventi[0].tipo).toBe('conversazione_creata');
    // Il token del telefono non apre l'import.
    expect((await fetch(`${s.url}/sync/conversazioni`, { headers: { authorization: `Bearer ${s.accesso.token}` } })).status).toBe(401);

    await fetch(`${s.url}/sync/conversazioni/c1`, { method: 'DELETE', headers: auth });
    expect((await (await fetch(`${s.url}/sync/conversazioni`, { headers: auth })).json()).conversazioni).toEqual([]);
  });
});

describe('ritorno al computer dello studio', () => {
  it('la conversazione fatta sul server entra nel log del computer, uguale, una volta sola', async () => {
    const s = await prepara();
    const t = await s.telefono();
    await t.comando({ tipo: 'conversazione.crea', argomenti: { conversazioneId: 'cs', modalita: 'pratica', praticaId: 'p1', titolo: 'A computer spento', procedura: null, qualita: 'Standard' } });
    await t.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'cs', testo: 'Scadenza?', qualita: 'Standard' } });
    s.motore().emetti('cs', { tipo: 'bozza', titolo: 'Diffida', contenuto: '## Diffida' });
    s.motore().emetti('cs', { tipo: 'completato', testo: 'Il 30 aprile.' });
    await s.motore().finisci('cs');
    await finche(() => t.elenco.conversazioni.cs?.stato === 'completata');
    await s.studio().salva();
    t.chiudi();

    // Il computer si riaccende: come importaConversazioni in src/main/serverPrivato.ts.
    const { Host } = await import('../host');
    const { apriDatabase } = await import('../db');
    const mac = new Host(apriDatabase(':memory:'), new MotoreFinto());
    const importa = async () => {
      for (const c of await s.desktop.elencoConversazioni()) {
        const { eventi } = JSON.parse(Buffer.from(decifraArchivio(CHIAVE, await s.desktop.scaricaConversazione(c.id))).toString());
        mac.importaConversazione(eventi);
        await s.desktop.eliminaConversazione(c.id);
      }
    };
    await importa();
    const c = mac.conversazione('cs')!;
    expect(c.titolo).toBe('A computer spento');
    expect(c.messaggi.map((m) => [m.ruolo, m.testo, m.dispositivoId])).toEqual([
      ['avvocato', 'Scadenza?', TEL],
      ['assistente', 'Il 30 aprile.', undefined],
    ]);
    expect(c.messaggi[1].bozza?.titolo).toBe('Diffida');
    expect(await s.desktop.elencoConversazioni()).toEqual([]);

    // Di nuovo lo stesso file (eliminazione non arrivata): niente doppioni.
    const eventi = JSON.parse(Buffer.from(decifraArchivio(CHIAVE, await cifraTutto(CHIAVE, Buffer.from(JSON.stringify({ eventi: [] }))))).toString());
    expect(eventi.eventi).toEqual([]);
    const primoGiro = mac.richiedi({ tipo: 'eventi.dopo', seq: 0, limite: 1000 }) as { eventi: unknown[] };
    expect(mac.importaConversazione((primoGiro.eventi as never[]).filter((e: { conversazioneId: string }) => e.conversazioneId === 'cs'))).toEqual({ importati: 0, giaPresente: true });
  });
});
