import { afterEach, describe, expect, it } from 'vitest';
import { ClienteRemoto } from '../../shared/clienteRemoto';
import { messaggiVisibili } from '../../shared/reducer';
import { apriDatabase } from '../db';
import { Host } from '../host';
import { migraResto } from '../migrazioneJson';
import { avviaTrasportoWs, type TrasportoWs } from '../trasportoWs';
import { MotoreFinto } from './motoreFinto';

// Passo 6: due client remoti (come due telefoni) sullo stesso host, via
// WebSocket vero. Lo stesso host serve anche la finestra via IPC.

const TOKEN: Record<string, string> = { 'token-telefono': 'telefono-giulia', 'token-portatile': 'portatile-marco' };

let aperti: Array<{ chiudi: () => unknown }> = [];
afterEach(async () => {
  for (const a of aperti.reverse()) await a.chiudi();
  aperti = [];
});

/** Aspetta che una condizione diventi vera (gli eventi viaggiano in rete). */
async function finche(condizione: () => boolean, ms = 2000): Promise<void> {
  const fine = Date.now() + ms;
  while (!condizione()) {
    if (Date.now() > fine) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function prepara() {
  const db = apriDatabase(':memory:');
  migraResto(db, { pratiche: [], documenti: {} });
  const motore = new MotoreFinto();
  const host = new Host(db, motore);
  const trasporto: TrasportoWs = await avviaTrasportoWs(host, {
    porta: 0,
    autentica: (t) => (t && TOKEN[t] ? { dispositivoId: TOKEN[t] } : null),
  });
  aperti.push(trasporto);
  const cliente = async (token: string) => {
    const c = new ClienteRemoto({ url: `ws://127.0.0.1:${trasporto.porta}/?token=${token}`, attesaMassimaMs: 50 });
    await c.connetti();
    aperti.push(c);
    return c;
  };
  return { host, motore, trasporto, cliente };
}

describe('client remoti sullo stesso host', () => {
  it('token sbagliato: connessione rifiutata', async () => {
    const { trasporto } = await prepara();
    const intruso = new ClienteRemoto({ url: `ws://127.0.0.1:${trasporto.porta}/?token=sbagliato` });
    await expect(intruso.connetti()).rejects.toThrow('Non autorizzato.');
  });

  it("quello che fa un client lo vede l'altro, in diretta e con il dispositivo giusto", async () => {
    const { motore, cliente } = await prepara();
    const telefono = await cliente('token-telefono');
    const portatile = await cliente('token-portatile');

    await telefono.comando({
      tipo: 'conversazione.crea',
      argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: null, titolo: '', procedura: null, qualita: 'Standard' },
    });
    await finche(() => !!portatile.elenco.conversazioni.c1);
    expect(portatile.elenco.conversazioni.c1.creataDa).toBe('telefono-giulia');

    await portatile.caricaConversazione('c1');
    await telefono.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'c1', testo: 'Scadenze?', qualita: 'Standard' } });
    motore.emetti('c1', { tipo: 'delta', testo: 'Sono ' });
    // Il testo in arrivo si vede anche sull'altro dispositivo.
    await finche(() => portatile.conversazione('c1')?.turno?.testoParziale === 'Sono ');
    expect(messaggiVisibili(portatile.conversazione('c1')!).at(-1)).toMatchObject({ isStreaming: true });

    motore.emetti('c1', { tipo: 'completato', testo: 'Sono tre.' });
    await motore.finisci('c1');
    await finche(() => portatile.conversazione('c1')?.stato === 'completata');
    expect(portatile.conversazione('c1')!.messaggi.map((m) => [m.ruolo, m.testo, m.dispositivoId])).toEqual([
      ['avvocato', 'Scadenze?', 'telefono-giulia'],
      ['assistente', 'Sono tre.', undefined],
    ]);
  });

  it('un client che perde la rete recupera tutto quello che è successo nel frattempo', async () => {
    const { motore, cliente, trasporto } = await prepara();
    const telefono = await cliente('token-telefono');
    const portatile = await cliente('token-portatile');
    await portatile.comando({
      tipo: 'conversazione.crea',
      argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: null, titolo: '', procedura: null, qualita: 'Standard' },
    });
    await finche(() => !!telefono.elenco.conversazioni.c1);
    await telefono.caricaConversazione('c1');

    // Il telefono va in galleria.
    telefono.simulaCaduta();
    await finche(() => !telefono.connesso);
    await portatile.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'c1', testo: 'Riassumi', qualita: 'Standard' } });
    motore.emetti('c1', { tipo: 'completato', testo: 'Ecco il riassunto.' });
    await motore.finisci('c1');
    await portatile.comando({ tipo: 'conversazione.rinomina', argomenti: { conversazioneId: 'c1', titolo: 'Riassunto' } });
    await portatile.comando({
      tipo: 'conversazione.crea',
      argomenti: { conversazioneId: 'c2', modalita: 'pratica', praticaId: null, titolo: 'Seconda', procedura: null, qualita: 'Standard' },
    });

    // Torna la rete: il client si ricollega da solo e recupera dal suo cursore.
    await finche(() => telefono.connesso && trasporto.connessioni() === 2, 3000);
    await finche(() => telefono.elenco.conversazioni.c2 !== undefined && telefono.conversazione('c1')?.messaggi.length === 2);
    expect(telefono.elenco.conversazioni.c1.titolo).toBe('Riassunto');
    expect(telefono.elenco.ultimoSeq).toBe(portatile.elenco.ultimoSeq);
    expect(telefono.conversazione('c1')!.messaggi.at(-1)?.testo).toBe('Ecco il riassunto.');
  });

  it('le modifiche alle entità arrivano agli altri con il dispositivo di chi le ha fatte', async () => {
    const { cliente } = await prepara();
    const telefono = await cliente('token-telefono');
    const portatile = await cliente('token-portatile');
    const ricevuti: unknown[] = [];
    // Il portatile guarda il proprio elenco: entita_cambiata ne fa avanzare il cursore.
    const prima = portatile.elenco.ultimoSeq;
    await telefono.comando({ tipo: 'studio.salva', argomenti: { studio: { nome: 'Studio Molfino', avvocato: '' } } });
    await finche(() => portatile.elenco.ultimoSeq > prima);
    const { eventi } = await portatile.richiesta<{ eventi: Array<{ tipo: string; dispositivoId?: string }> }>({
      tipo: 'eventi.dopo',
      seq: prima,
      limite: 10,
    });
    ricevuti.push(...eventi);
    expect(eventi).toEqual([expect.objectContaining({ tipo: 'entita_cambiata', dispositivoId: 'telefono-giulia' })]);
    const { entita } = await portatile.richiesta<{ entita: { studio: { nome: string } } }>({ tipo: 'snapshot.entita' });
    expect(entita.studio.nome).toBe('Studio Molfino');
  });
});
