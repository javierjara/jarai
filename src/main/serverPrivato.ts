import { app, ipcMain, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { decifraArchivio, type AccessoServer } from '../shared/archivio';
import type { Evento } from '../shared/protocollo';
import { casuale } from '../shared/cifratura';
import { dispositivoAttivo, elencaDispositivi } from '../core/dispositivi';
import { join } from 'node:path';
import type { Database } from '../core/db';
import type { Host } from '../core/host';
import { createHash } from 'node:crypto';
import { cifraTutto } from '../core/cifraturaArchivio';
import { ClienteArchivio, costruisciPacchetto, fileDaSincronizzare, Sincronizzatore, testiDaSincronizzare, type StatoSincronizzazione } from '../core/sincronizzazione';
import { percorsoTestoIndicizzato } from './indice';
import { leggiMemoria } from './memoriaPratica';
import { registraErroreGrezzo } from './logger';
import { funzioneAttiva, leggiLicenza, statoLicenza } from './licenza';
import { cifraturaDisponibile, leggiCifrato, scriviCifrato } from './segreti';

// "Server privato" (JarAI Server): copia i file delle pratiche sul server
// dello studio (src/core/sincronizzazione.ts). Si attiva dal CRM: funzione
// "server_privato" e indirizzo del server sulla licenza. In sviluppo
// JARAI_SERVER_URL lo attiva senza CRM.

const OGNI = 10 * 60_000;
const CHIAVE_PATH = () => join(app.getPath('userData'), 'server-chiave.bin');

/**
 * La chiave con cui si cifrano i file per il server: nasce qui e resta qui,
 * protetta dal portachiavi del sistema. Se si perde (computer nuovo) se ne
 * crea un'altra e il server viene ricaricato da capo: gli originali sono in
 * studio.
 */
async function chiaveStudio(): Promise<Uint8Array | null> {
  if (!(await cifraturaDisponibile())) return null;
  const salvata = await leggiCifrato(CHIAVE_PATH());
  if (salvata) return Buffer.from(salvata, 'base64');
  const nuova = randomBytes(32);
  await scriviCifrato(CHIAVE_PATH(), nuova.toString('base64'));
  return nuova;
}
const DOPO_MODIFICA = 5_000;

export interface StatoServerPrivato {
  attivo: boolean;
  url: string | null;
  stato: StatoSincronizzazione;
}

export interface ServerPrivatoPerTelefoni {
  /** Accesso in sola lettura ai file (cifrati) per un telefono collegato; null se il server privato non c'è. */
  accessoTelefono: (dispositivoId: string) => Promise<AccessoServer | null>;
  revocaTelefono: (dispositivoId: string) => void;
}

export function registraServerPrivato(db: Database, host: Host, getWindow: () => BrowserWindow | null): ServerPrivatoPerTelefoni {
  let sinc: Sincronizzatore | null = null;
  let cliente: ClienteArchivio | null = null;
  let chiave: Uint8Array | null = null;
  let url: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let attesa: ReturnType<typeof setTimeout> | null = null;

  const notifica = () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('server:cambio');
  };

  const stato = (): StatoServerPrivato => ({ attivo: !!sinc, url, stato: sinc?.stato ?? { tipo: 'disattivata' } });

  /** Rilegge licenza e funzioni: attiva, cambia o spegne la sincronizzazione. */
  const configura = async (): Promise<void> => {
    const licenza = await leggiLicenza();
    let nuovo: string | null = process.env.JARAI_SERVER_URL ?? null;
    if (!nuovo && licenza && (await funzioneAttiva('server_privato'))) nuovo = (await statoLicenza(licenza)).server?.url ?? null;
    if (!licenza || !nuovo) {
      if (sinc) {
        sinc = null;
        cliente = null;
        url = null;
        notifica();
      }
      return;
    }
    if (sinc && nuovo === url) return;
    chiave = await chiaveStudio();
    if (!chiave) {
      void registraErroreGrezzo('server chiave', 'cifratura del sistema non disponibile: sincronizzazione ferma');
      return;
    }
    url = nuovo;
    cliente = new ClienteArchivio(nuovo, licenza);
    sinc = new Sincronizzatore({
      cliente,
      chiave,
      // I file e, accanto, i testi già estratti (per l'assistente di riserva sul server).
      locali: async () => [...fileDaSincronizzare(db), ...(await testiDaSincronizzare(db, (p) => percorsoTestoIndicizzato(p)))],
      onStato: notifica,
      registraErrore: (contesto, dettaglio) => void registraErroreGrezzo(`server ${contesto}`, dettaglio),
    });
    notifica();
    void sinc.sincronizza();
  };

  // Il pacchetto si ricarica solo se cambia (impronta del contenuto in chiaro).
  let ultimoPacchetto: string | null = null;
  const caricaPacchetto = async () => {
    if (!cliente || !chiave) return;
    const pratiche = (db.prepare('SELECT id FROM pratica WHERE eliminata_il IS NULL').all() as Array<{ id: string }>).map((r) => r.id);
    const memorie: Record<string, unknown> = {};
    for (const id of pratiche) memorie[id] = await leggiMemoria(id).catch(() => null);
    const p = costruisciPacchetto(db, { memorie, ora: '' });
    const testo = JSON.stringify(p);
    const impronta = createHash('sha256').update(testo).digest('hex');
    if (impronta === ultimoPacchetto) return;
    await cliente.caricaPacchetto(await cifraTutto(chiave, Buffer.from(JSON.stringify({ ...p, creatoIl: new Date().toISOString() }))));
    ultimoPacchetto = impronta;
  };

  // Le conversazioni fatte dal telefono sull'assistente di riserva, mentre
  // questo computer era spento: entrano nel log di qui e si tolgono dal server.
  const importaConversazioni = async () => {
    if (!cliente || !chiave) return;
    for (const c of await cliente.elencoConversazioni()) {
      if (c.inCorso) continue; // si prende al prossimo giro, a risposta finita
      const { eventi } = JSON.parse(Buffer.from(decifraArchivio(chiave, await cliente.scaricaConversazione(c.id))).toString('utf8')) as { eventi: Evento[] };
      host.importaConversazione(eventi);
      await cliente.eliminaConversazione(c.id);
    }
  };

  const giro = async () => {
    await configura();
    await importaConversazioni().catch((err) => void registraErroreGrezzo('server importazione', err instanceof Error ? err.message : String(err)));
    if (sinc) await sinc.sincronizza();
    await caricaPacchetto().catch((err) => void registraErroreGrezzo('server pacchetto', err instanceof Error ? err.message : String(err)));
    // Telefoni scollegati mentre il server non rispondeva: il server li toglie ora.
    if (cliente) {
      const attivi = elencaDispositivi(db).filter((d) => !d.revocatoIl).map((d) => d.id);
      await cliente.telefoniAttivi(attivi).catch(() => undefined);
    }
  };

  // Documenti aggiunti o tolti: si sincronizza poco dopo (più modifiche di fila = un giro).
  host.abbona((e) => {
    if (e.tipo !== 'entita_cambiata' || (e.payload.entita !== 'documento' && e.payload.entita !== 'pratica') || !sinc) return;
    if (attesa) clearTimeout(attesa);
    attesa = setTimeout(() => void sinc?.sincronizza(), DOPO_MODIFICA);
  });

  ipcMain.handle('server:stato', async () => {
    await configura().catch(() => undefined);
    return stato();
  });
  ipcMain.handle('server:sincronizza', async () => {
    await giro();
    return stato();
  });

  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    if (attesa) clearTimeout(attesa);
  });

  const accessoTelefono = async (dispositivoId: string): Promise<AccessoServer | null> => {
    await configura();
    if (!cliente || !url || !chiave || !dispositivoAttivo(db, dispositivoId)) return null;
    // Un token nuovo a ogni richiesta: quello vecchio smette di valere.
    const token = casuale(32);
    await cliente.registraTelefono(dispositivoId, token);
    return { url, token: `${dispositivoId}.${token}`, chiave: Buffer.from(chiave).toString('base64') };
  };

  const revocaTelefono = (dispositivoId: string) => {
    // Se il server ora non risponde, ci pensa il prossimo giro (telefoniAttivi).
    void cliente?.revocaTelefono(dispositivoId).catch(() => undefined);
  };

  // Si parte qualche secondo dopo l'avvio, per non rallentare la finestra.
  setTimeout(() => {
    void giro().catch((err) => void registraErroreGrezzo('server avvio', err instanceof Error ? err.message : String(err)));
    timer = setInterval(() => void giro().catch(() => undefined), OGNI);
  }, 8_000);

  return { accessoTelefono, revocaTelefono };
}
