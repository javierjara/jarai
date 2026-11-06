import { app, ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { apriDatabase } from '../core/db';
import { Host, type EventoMotore, type Motore } from '../core/host';
import { MIGRAZIONE_CONVERSAZIONI, MIGRAZIONE_RESTO, migraConversazioniPratica, migraResto, migrazioneFatta } from '../core/migrazioneJson';
import { fermaMessaggio, inviaMessaggio, type EventoAgente } from './agentRunner';
import { registraErroreGrezzo } from './logger';
import { caricaDati, DATI_PATH } from './store';

// L'host sul desktop (docs/eventstore-protocollo.md, passi 4 e 5): jarai.db
// nella cartella dati dell'app, l'agente di agentRunner come Motore e la
// finestra collegata via IPC. Conversazioni, pratiche, documenti e Studio
// digitale passano tutti di qui. Solo la richiesta di idee usa ancora
// claude:invia: è una chiamata singola, non una conversazione da tenere.

const DB_PATH = () => join(app.getPath('userData'), 'jarai.db');
// Copia del JSON presa prima della migrazione: la via di ritorno.
const COPIA_PATH = () => join(app.getPath('userData'), 'jarai-dati.prima-di-jarai-db.json');
const RINOMINATO_PATH = () => join(app.getPath('userData'), `jarai-dati.migrato-${new Date().toISOString().slice(0, 10)}.json`);
const DISPOSITIVO_DESKTOP = 'desktop';

export interface HostDesktop {
  host: Host;
  conversazioniNelDatabase: () => boolean;
}

export async function avviaHost(getWindow: () => BrowserWindow | null): Promise<HostDesktop> {
  const db = apriDatabase(DB_PATH());
  let migrate = migrazioneFatta(db, MIGRAZIONE_CONVERSAZIONI);

  if (!migrate) {
    const fileEsiste = await fs.access(DATI_PATH()).then(
      () => true,
      () => false,
    );
    const dati = await caricaDati();
    if (fileEsiste && !dati) {
      // File presente ma illeggibile: non si migra "niente" segnandolo come
      // fatto. Si riprova al prossimo avvio; intanto il file resta com'è.
      void registraErroreGrezzo('migrazione-conversazioni', 'jarai-dati.json presente ma non leggibile: migrazione rimandata');
    } else {
      try {
        if (dati?.conversazioni?.length) {
          await fs.copyFile(DATI_PATH(), COPIA_PATH()).catch(() => undefined);
        }
        const r = migraConversazioniPratica(db, dati?.conversazioni ?? []);
        void registraErroreGrezzo('migrazione-conversazioni', `fatta: ${r.conversazioni} conversazioni, ${r.eventi} eventi`);
        migrate = true;
      } catch (err) {
        // Annullata per intero (transazione): le conversazioni restano nel
        // JSON e store.ts non le cancella finché migrate è false.
        void registraErroreGrezzo('migrazione-conversazioni', err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    }
  }

  // Seconda parte (passo 5): pratiche, documenti, impostazioni, Studio
  // digitale. Solo dopo la prima: se quella è fallita, tutto resta sul JSON.
  if (migrate && !migrazioneFatta(db, MIGRAZIONE_RESTO)) {
    const fileEsiste = await fs.access(DATI_PATH()).then(
      () => true,
      () => false,
    );
    const dati = await caricaDati();
    if (fileEsiste && !dati) {
      void registraErroreGrezzo('migrazione-entita', 'jarai-dati.json presente ma non leggibile: migrazione rimandata');
    } else {
      try {
        const r = migraResto(db, dati ?? { pratiche: [], documenti: {}, conversazioni: [] });
        void registraErroreGrezzo(
          'migrazione-entita',
          `fatta: ${r.pratiche} pratiche, ${r.documenti} documenti, ${r.conversazioniSito} articoli, ${r.idee} idee, ${r.eventi} eventi`,
        );
        // Il JSON non serve più: si rinomina (mai cancellato) così nessuno
        // lo legge per sbaglio, e resta come copia dello stato di oggi.
        if (fileEsiste) await fs.rename(DATI_PATH(), RINOMINATO_PATH());
      } catch (err) {
        // Annullata per intero: la finestra resta sul JSON (snapshot.entita null).
        void registraErroreGrezzo('migrazione-entita', err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    }
  }

  const host = new Host(db, motoreDesktop, {
    registraErrore: (contesto, dettaglio) => void registraErroreGrezzo(`host ${contesto}`, dettaglio),
  });

  host.abbona((evento) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('jarai:evento', evento);
  });

  ipcMain.handle('jarai:busta', (_event, busta: unknown) => host.gestisciBusta(busta, { dispositivoId: DISPOSITIVO_DESKTOP }));

  return { host, conversazioniNelDatabase: () => migrate };
}

// L'agente di sempre (agentRunner) visto dall'host. I documenti arrivano da
// jarai.db; finché le pratiche non sono migrate (migrazione fallita) si
// leggono dal JSON, come prima.
const motoreDesktop: Motore = {
  async esegui(r, emetti) {
    const daJson = r.praticaId && r.documenti.length === 0 ? ((await caricaDati())?.documenti[r.praticaId] ?? []) : [];
    const documenti = (r.documenti.length ? r.documenti : daJson).map((d) => ({
      nome: d.nome,
      percorso: d.percorso,
      cartella: d.cartella,
      tipo: d.tipo,
      pagine: d.pagine,
    }));
    await inviaMessaggio(
      {
        conversazioneId: r.conversazioneId,
        modalita: r.modalita,
        testo: r.testo,
        qualita: r.qualita,
        praticaId: r.praticaId ?? undefined,
        documenti,
        resume: r.resume,
      },
      (e) => {
        const tradotto = daEventoAgente(e);
        if (tradotto) emetti(tradotto);
      },
    );
  },
  ferma: fermaMessaggio,
};

function daEventoAgente(e: EventoAgente): EventoMotore | null {
  switch (e.tipo) {
    case 'delta':
    case 'attivita':
      return { tipo: e.tipo, testo: e.testo };
    case 'lavori':
      return { tipo: 'lavori', lavori: e.lavori };
    case 'bozza':
      return { tipo: 'bozza', titolo: e.titolo, contenuto: e.contenuto };
    case 'articolo':
      return { tipo: 'articolo', articolo: e.articolo };
    case 'idee':
      return { tipo: 'idee', idee: e.idee };
    case 'sessione':
      return { tipo: 'sessione', sessionId: e.sessionId };
    case 'completato':
      return { tipo: 'completato', testo: e.testo, costoUsd: e.costoUsd };
    case 'errore':
      return { tipo: 'errore', messaggio: e.messaggio, ...(e.scartaParziale ? { scartaParziale: true } : {}) };
  }
}
