import { afterEach, describe, expect, it } from 'vitest';
import { casuale, generaCoppia } from '../../shared/cifratura';
import { ClienteRemoto } from '../../shared/clienteRemoto';
import { abbinaTelefono, canaleRelay, leggiInvito, type CredenzialiTelefono } from '../../shared/relay';
import { apriDatabase } from '../db';
import { elencaDispositivi } from '../dispositivi';
import { Host } from '../host';
import { migraResto } from '../migrazioneJson';
import { PonteRelay, type StatoPonte } from '../ponteRelay';
import { MotoreFinto } from './motoreFinto';

// Telefono ↔ jarai-relay ↔ desktop, con il relay vero in locale:
//   cd ../jarai-relay && npx wrangler dev --port 8790 --ip 127.0.0.1
//   JARAI_RELAY_PROVA=ws://127.0.0.1:8790 npx vitest run src/core/__tests__/relay.test.ts
// Senza la variabile la prova si salta.

const RELAY = process.env.JARAI_RELAY_PROVA;

let aperti: Array<{ chiudi?: () => unknown; ferma?: () => unknown }> = [];
afterEach(async () => {
  for (const a of aperti.reverse()) await (a.chiudi ?? a.ferma)?.call(a);
  aperti = [];
});

async function finche(condizione: () => boolean, ms = 5000): Promise<void> {
  const fine = Date.now() + ms;
  while (!condizione()) {
    if (Date.now() > fine) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function desktop(opzioni: { conferma?: (nome: string) => Promise<boolean>; durataInvitoMs?: number } = {}) {
  const db = apriDatabase(':memory:');
  migraResto(db, { pratiche: [], documenti: {} });
  const motore = new MotoreFinto();
  const host = new Host(db, motore);
  const coppia = await generaCoppia();
  const identita = { hostId: casuale(18), segreto: casuale(32), privata: coppia.privata, pubblica: coppia.pubblica };
  const stati: StatoPonte[] = [];
  const ponte = new PonteRelay({
    relay: RELAY!,
    identita,
    host,
    db,
    nomeComputer: 'Mac dello studio',
    conferma: opzioni.conferma ?? (async () => true),
    onStato: (s) => stati.push(s),
    durataInvitoMs: opzioni.durataInvitoMs,
  });
  ponte.avvia();
  aperti.push(ponte);
  await finche(() => ponte.stato === 'collegato');
  return { db, host, motore, ponte, identita, stati };
}

async function telefono(credenziali: CredenzialiTelefono) {
  const c = new ClienteRemoto({ canale: () => canaleRelay(credenziali), attesaMassimaMs: 200 });
  aperti.push(c);
  await c.connetti();
  return c;
}

describe.skipIf(!RELAY)('telefono attraverso jarai-relay', () => {
  it('abbinamento con QR, poi comandi ed eventi cifrati in entrambe le direzioni', async () => {
    const nomi: string[] = [];
    const { db, motore, ponte } = await desktop({ conferma: async (n) => (nomi.push(n), true) });
    const { qr } = await ponte.nuovoInvito();
    const invito = leggiInvito(qr)!;
    expect(invito.nome).toBe('Mac dello studio');

    const credenziali = await abbinaTelefono(invito, 'iPhone di Giulia');
    expect(nomi).toEqual(['iPhone di Giulia']);
    expect(credenziali.nomeComputer).toBe('Mac dello studio');
    expect(elencaDispositivi(db).map((d) => d.nome)).toEqual(['iPhone di Giulia']);

    const t = await telefono(credenziali);
    await t.comando({
      tipo: 'conversazione.crea',
      argomenti: { conversazioneId: 'c1', modalita: 'pratica', praticaId: null, titolo: 'Dal telefono', procedura: null, qualita: 'Standard' },
    });
    expect(t.elenco.conversazioni.c1.creataDa).toBe(credenziali.dispositivoId);

    await t.caricaConversazione('c1');
    await t.comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: 'c1', testo: 'Scadenze?', qualita: 'Standard' } });
    for (const pezzo of ['Sono ', 'tre ', 'scadenze.']) motore.emetti('c1', { tipo: 'delta', testo: pezzo });
    await finche(() => t.conversazione('c1')?.turno?.testoParziale === 'Sono tre scadenze.');
    motore.emetti('c1', { tipo: 'completato', testo: 'Sono tre scadenze.' });
    await motore.finisci('c1');
    await finche(() => t.conversazione('c1')?.stato === 'completata');
  });

  it('il QR vale una volta sola', async () => {
    const { ponte } = await desktop();
    const invito = leggiInvito((await ponte.nuovoInvito()).qr)!;
    await abbinaTelefono(invito, 'Primo');
    await expect(abbinaTelefono(invito, 'Secondo')).rejects.toThrow(/scaduto|usato/);
  });

  it("rifiutato sul computer: il telefono lo sa e non c'è nessun dispositivo", async () => {
    const { db, ponte } = await desktop({ conferma: async () => false });
    const invito = leggiInvito((await ponte.nuovoInvito()).qr)!;
    await expect(abbinaTelefono(invito, 'Sconosciuto')).rejects.toThrow('Collegamento rifiutato sul computer.');
    expect(elencaDispositivi(db)).toEqual([]);
  });

  it('un QR con un segreto inventato non passa nemmeno dal relay', async () => {
    const { ponte } = await desktop();
    const invito = leggiInvito((await ponte.nuovoInvito()).qr)!;
    await expect(abbinaTelefono({ ...invito, segreto: casuale(32) }, 'Intruso')).rejects.toThrow(/scaduto|usato/);
  });

  it('revoca: il telefono viene chiuso e non può tornare', async () => {
    const { ponte } = await desktop();
    const credenziali = await abbinaTelefono(leggiInvito((await ponte.nuovoInvito()).qr)!, 'Vecchio telefono');
    const t = await telefono(credenziali);
    ponte.revoca(credenziali.dispositivoId);
    await finche(() => !t.connesso);
    expect(t.motivo).toBe('Questo dispositivo è stato scollegato dal computer.');
    await expect(new ClienteRemoto({ canale: () => canaleRelay(credenziali) }).connetti()).rejects.toThrow('Non autorizzato.');
  });

  it('il computer si scollega e torna: il telefono si riprende da solo e recupera gli eventi', async () => {
    const d = await desktop();
    const credenziali = await abbinaTelefono(leggiInvito((await d.ponte.nuovoInvito()).qr)!, 'iPhone');
    const t = await telefono(credenziali);

    d.ponte.ferma();
    await finche(() => !t.connesso);
    expect(t.motivo).toBe('Il computer dello studio è spento o non collegato.');
    // Intanto sul computer succede qualcosa.
    await d.host.gestisciBusta({
      v: 1,
      tipo: 'comando',
      id: 'x',
      comando: {
        tipo: 'conversazione.crea',
        comandoId: 'k1',
        argomenti: { conversazioneId: 'c2', modalita: 'pratica', praticaId: null, titolo: 'Dal Mac', procedura: null, qualita: 'Standard' },
      },
    });
    d.ponte.avvia();
    await finche(() => t.connesso && !!t.elenco.conversazioni.c2, 10_000);
  }, 15_000);

  it('una stanza appartiene al primo computer: un altro segreto viene rifiutato', async () => {
    const d = await desktop();
    d.ponte.ferma();
    const altro = new PonteRelay({
      relay: RELAY!,
      identita: { ...d.identita, segreto: casuale(32) },
      host: d.host,
      db: d.db,
      conferma: async () => true,
    });
    altro.avvia();
    aperti.push(altro);
    await finche(() => altro.stato === 'rifiutato');
  });
});
