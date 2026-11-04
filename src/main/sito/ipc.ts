import { BrowserWindow, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { funzioneAttiva, funzioniAttive } from '../licenza';
import { anteprimaImmagine, caricaDalComputer, cercaFoto, copertineProposte, immaginiDelSito, scegliProposta } from './immagini';
import { annullaProgrammazione, avviaProgrammazione, elencoProgrammate, programma, ritiraEsiti } from './programmazione';
import { salvaCarosello } from './social';
import { leggiStatistiche, rimuoviVecchiaChiaveUmami } from './statistiche';
import { ErroreSito, collegaSito, elencaArticoli, inviaBozza, pubblicaArticolo, scollegaSito, statoArticolo, statoSito } from './payload';

// Canali IPC dello Studio digitale. Ogni scrittura sul sito passa da qui ed
// è sempre un clic esplicito dell'avvocato nel pannello dell'articolo (con
// conferma per la pubblicazione, spec §7): Claude non ha strumenti che
// scrivono sul sito.

export const FUNZIONE_STUDIO_DIGITALE = 'studio_digitale';

const collegaSchema = z.object({ url: z.string().trim().min(3), email: z.string().trim().min(3), password: z.string().min(1) });
const idSchema = z.union([z.number(), z.string().min(1)]);
const articoloSchema = z.object({
  titolo: z.string().trim().min(1),
  slug: z.string(),
  metaTitolo: z.string(),
  metaDescrizione: z.string(),
  categorie: z.array(z.string()),
  contenuto: z.string().min(1),
});
const copertinaSchema = z.object({
  file: z.string().min(1),
  alt: z.string().max(300),
  origine: z.enum(['copertina', 'foto', 'sito', 'caricata']),
  credito: z.string().max(200).optional(),
  mediaId: idSchema.optional(),
});
const inviaSchema = z.object({ articolo: articoloSchema, idEsistente: idSchema.optional(), copertina: copertinaSchema.optional() });
const datiCopertinaSchema = z.object({
  titolo: z.string().trim().min(1).max(200),
  categoria: z.string().max(80).optional(),
  firma: z.string().max(120).optional(),
});
const cercaFotoSchema = z.object({ testo: z.string().trim().min(2).max(100), titolo: z.string().max(200) });
const propostaSchema = z.object({
  origine: z.enum(['copertina', 'foto', 'sito']),
  rif: z.string().min(1).max(2000),
  alt: z.string().max(300),
  credito: z.string().max(200).optional(),
});
const urlSchema = z.string().url();
const programmaSchema = z.object({
  conversazioneId: z.string().min(1),
  postId: idSchema,
  titolo: z.string().min(1).max(300),
  quando: z.string().min(10),
});
const caroselloSchema = z.object({
  slide: z.array(z.object({ titoletto: z.string().max(80), testo: z.string().max(600) })).min(1).max(10),
  firma: z.string().max(120),
  sito: z.string().max(120),
  sfondo: z.string().optional(),
  nome: z.string().max(200),
});
const statisticheSchema = z.object({ giorni: z.number().int().min(7).max(365), forza: z.boolean().optional() });

type Esito<T> = { ok: true; dati: T } | { ok: false; errore: string };

async function esegui<T>(lavoro: () => Promise<T>): Promise<Esito<T>> {
  try {
    if (!(await funzioneAttiva(FUNZIONE_STUDIO_DIGITALE))) {
      return { ok: false, errore: 'Lo Studio digitale non è attivo per questa licenza JarAI.' };
    }
    return { ok: true, dati: await lavoro() };
  } catch (err) {
    return { ok: false, errore: err instanceof ErroreSito ? err.message : 'Operazione sul sito non riuscita. Riprova.' };
  }
}

export function registraSito(): void {
  avviaProgrammazione();

  // Il renderer chiede quali sezioni mostrare; "forza" dopo l'attivazione
  // di una licenza, per non aspettare la scadenza della cache.
  ipcMain.handle('funzioni:attive', async (_event, forza: unknown) => funzioniAttive(forza === true));

  ipcMain.handle('sito:stato', async () => statoSito());

  ipcMain.handle('sito:collega', async (_event, input: unknown) => {
    const { url, email, password } = collegaSchema.parse(input);
    return esegui(() => collegaSito(url, email, password));
  });

  ipcMain.handle('sito:scollega', async () => scollegaSito());

  ipcMain.handle('sito:articoli', async () => esegui(async () => (await elencaArticoli(true)).articoli.length));

  // Articoli pubblicati con data e indirizzo (calendario, statistiche).
  ipcMain.handle('sito:elenco-articoli', async (_event, forza: unknown) =>
    esegui(async () => (await statoSito()).collegato ? (await elencaArticoli(forza === true)).articoli : []),
  );

  // Pubblicazione programmata (programmazione.ts): l'avvocato approva ora,
  // JarAI pubblica all'ora scelta.
  ipcMain.handle('sito:programma', async (_event, input: unknown) => {
    const voce = programmaSchema.parse(input);
    return esegui(() => programma(voce));
  });
  ipcMain.handle('sito:annulla-programmazione', async (_event, id: unknown) =>
    esegui(() => annullaProgrammazione(z.string().min(1).parse(id))),
  );
  ipcMain.handle('sito:programmate', async () => elencoProgrammate());
  ipcMain.handle('sito:ritira-esiti', async () => ritiraEsiti());

  // Carosello Instagram salvato come immagini in una cartella scelta.
  ipcMain.handle('sito:salva-carosello', async (event, input: unknown) => {
    const { nome, ...dati } = caroselloSchema.parse(input);
    return esegui(() => salvaCarosello(dati, BrowserWindow.fromWebContents(event.sender), nome));
  });

  // Statistiche: Google (Search Console) e visite (botcom analytics), entrambe dal proxy.
  ipcMain.handle('sito:statistiche', async (_event, input: unknown) => {
    const { giorni, forza } = statisticheSchema.parse(input);
    return esegui(() => leggiStatistiche(giorni, forza));
  });
  void rimuoviVecchiaChiaveUmami();

  // Condivisione su LinkedIn di un articolo pubblicato: si apre la pagina
  // di LinkedIn nel browser, il post lo conferma l'avvocato lì.
  ipcMain.handle('sito:condividi-linkedin', async (_event, urlInput: unknown) => {
    const url = urlSchema.parse(urlInput);
    const stato = await statoSito();
    if (!stato.url || !url.startsWith(`${stato.url}/`)) return;
    await shell.openExternal(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`);
  });

  ipcMain.handle('sito:invia-bozza', async (_event, input: unknown) => {
    const { articolo, idEsistente, copertina } = inviaSchema.parse(input);
    return esegui(() => inviaBozza(articolo, idEsistente, copertina));
  });

  // Immagine di copertina: proposte, scelta e caricamento restano su questo
  // computer; l'immagine va sul sito solo con «Invia/Aggiorna bozza».
  ipcMain.handle('sito:copertine', async (_event, input: unknown) => {
    const dati = datiCopertinaSchema.parse(input);
    return esegui(() => copertineProposte(dati));
  });

  ipcMain.handle('sito:cerca-foto', async (_event, input: unknown) => {
    const { testo, titolo } = cercaFotoSchema.parse(input);
    return esegui(() => cercaFoto(testo, titolo));
  });

  ipcMain.handle('sito:immagini-sito', async () => esegui(() => immaginiDelSito()));

  ipcMain.handle('sito:scegli-immagine', async (_event, input: unknown) => {
    const proposta = propostaSchema.parse(input);
    return esegui(() => scegliProposta(proposta));
  });

  ipcMain.handle('sito:carica-immagine', async (event) =>
    esegui(() => caricaDalComputer(BrowserWindow.fromWebContents(event.sender))),
  );

  ipcMain.handle('sito:anteprima-immagine', async (_event, file: unknown) => anteprimaImmagine(z.string().min(1).parse(file)));

  ipcMain.handle('sito:pubblica', async (_event, idInput: unknown) => {
    const id = idSchema.parse(idInput);
    return esegui(() => pubblicaArticolo(id));
  });

  ipcMain.handle('sito:stato-articolo', async (_event, idInput: unknown) => {
    const id = idSchema.parse(idInput);
    return esegui(() => statoArticolo(id));
  });

  // Apre il pannello del sito o l'articolo pubblicato nel browser di
  // sistema: solo indirizzi del sito collegato.
  ipcMain.handle('sito:apri', async (_event, urlInput: unknown) => {
    const url = urlSchema.parse(urlInput);
    const stato = await statoSito();
    if (stato.url && url.startsWith(`${stato.url}/`)) await shell.openExternal(url);
  });
}
