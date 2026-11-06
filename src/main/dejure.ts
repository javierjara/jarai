import { app, BrowserWindow, ipcMain, session, type Session, type WebFrameMain } from 'electron';
import { leggiCifrato, scriviCifrato } from './segreti';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Integrazione DeJure (Lefebvre Giuffrè). DeJure non offre un'API: JarAI
// apre il sito in una finestra nascosta, con le credenziali dell'avvocato,
// e ne legge le pagine di ricerca e di dettaglio come farebbe lui.
//
// È un'integrazione che l'avvocato attiva da sé, accettando un'avvertenza
// esplicita (Impostazioni → Integrazioni): la licenza d'uso DeJure (art. 4.4)
// limita l'uso dei dati a esigenze professionali proprie, e l'accesso
// automatizzato resta sotto la sua responsabilità. Per questo:
//  - le credenziali sono sue, cifrate con safeStorage come la chiave dello
//    studio (claudeAuth.ts), mai in chiaro e mai nella cartella della pratica;
//  - la sessione DeJure vive in una partizione separata (persist:dejure),
//    lontana da quella dell'app (CSP, cookie);
//  - una richiesta alla volta e un tetto di consultazioni per domanda: ricerche
//    puntuali, mai scaricamenti in blocco.

const BASE = 'https://dejure.lefebvregiuffre.it';
const PARTIZIONE = 'persist:dejure';
const CREDENZIALI_PATH = () => join(app.getPath('userData'), 'dejure-credenziali.enc');
const STATO_PATH = () => join(app.getPath('userData'), 'dejure.json');

// Consultazioni DeJure (ricerche + letture) per singola domanda all'assistente.
export const CONSULTAZIONI_MAX_PER_DOMANDA = 15;
const LUNGHEZZA_MAX_TESTO = 60_000;

interface Credenziali {
  utente: string;
  password: string;
}

interface StatoSalvato {
  utente: string;
  avvertenzaAccettataIl: string;
  collegatoIl: string;
}

export interface StatoDejure {
  attiva: boolean;
  utente?: string;
  avvertenzaAccettataIl?: string;
}

// ─── Credenziali e stato ────────────────────────────────────────────────

async function salvaCredenziali(cred: Credenziali): Promise<void> {
  await scriviCifrato(CREDENZIALI_PATH(), JSON.stringify(cred));
}

async function leggiCredenziali(): Promise<Credenziali | null> {
  const testo = await leggiCifrato(CREDENZIALI_PATH());
  try {
    return testo ? (JSON.parse(testo) as Credenziali) : null;
  } catch {
    return null;
  }
}

async function leggiStatoSalvato(): Promise<StatoSalvato | null> {
  try {
    return JSON.parse(await fs.readFile(STATO_PATH(), 'utf-8')) as StatoSalvato;
  } catch {
    return null;
  }
}

export async function statoDejure(): Promise<StatoDejure> {
  const [stato, cred] = await Promise.all([leggiStatoSalvato(), leggiCredenziali()]);
  if (!stato || !cred) return { attiva: false };
  return { attiva: true, utente: stato.utente, avvertenzaAccettataIl: stato.avvertenzaAccettataIl };
}

export async function dejureAttiva(): Promise<boolean> {
  return (await statoDejure()).attiva;
}

// ─── Finestra nascosta ──────────────────────────────────────────────────

let finestra: BrowserWindow | null = null;
let coda: Promise<unknown> = Promise.resolve();

// Una richiesta alla volta sulla stessa finestra: due ricerche in parallelo
// si pesterebbero i piedi (stessa pagina) e sembrerebbero un uso anomalo.
function inCoda<T>(lavoro: () => Promise<T>): Promise<T> {
  const risultato = coda.then(lavoro, lavoro);
  coda = risultato.catch(() => undefined);
  return risultato;
}

function sessioneDejure(): Session {
  const ses = session.fromPartition(PARTIZIONE);
  // Lo user agent di Electron contiene "Electron/x.y": alcuni siti lo
  // trattano come un client sconosciuto. Si presenta come il Chrome che è.
  ses.setUserAgent(ses.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*jarai\/\S+/i, ''));
  return ses;
}

function apriFinestra(): BrowserWindow {
  if (finestra && !finestra.isDestroyed()) return finestra;
  finestra = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: sessioneDejure(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Nessun throttling: la finestra non è mai visibile, ma le pagine
      // devono comunque caricare e disegnare i risultati.
      backgroundThrottling: false,
    },
  });
  finestra.webContents.setAudioMuted(true);
  finestra.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  finestra.on('closed', () => {
    finestra = null;
  });
  return finestra;
}

function chiudiFinestra(): void {
  if (finestra && !finestra.isDestroyed()) finestra.destroy();
  finestra = null;
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function js<T>(win: BrowserWindow, codice: string): Promise<T> {
  return (await win.webContents.executeJavaScript(codice, true)) as T;
}

async function caricaPagina(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
  } catch (err) {
    // Le SPA annullano spesso il primo caricamento con un redirect interno
    // (ERR_ABORTED): la pagina arriva comunque, il resto lo verifica chi chiama.
    if (!/ERR_ABORTED/.test(String(err))) throw err;
  }
}

async function attendi<T>(win: BrowserWindow, codice: string, timeoutMs: number): Promise<T | null> {
  const fine = Date.now() + timeoutMs;
  while (Date.now() < fine) {
    try {
      const valore = await js<T>(win, codice);
      if (valore) return valore;
    } catch {
      // Pagina in navigazione: si riprova al giro successivo.
    }
    await pausa(300);
  }
  return null;
}

// Stato del login letto dall'intestazione del sito, che cambia forma con la
// larghezza della finestra: da disconnessi c'è il pulsante "Login" (icona o
// scritta) e il modulo di accesso incorporato; da collegati il campo di
// ricerca, i risultati o il documento.
const SELETTORE_FUORI = 'img[alt="Login"], .gfl-hf-res-login, iframe[src*="logingfl/Login"]';
const SELETTORE_DENTRO = 'input[placeholder="Cerca massime e sentenze"], .contenuto-ricerca-articoli, .titolo-dettaglio, .tipoud-main-col';
const CODICE_STATO_ACCESSO = `(() => {
  if (document.querySelector('${SELETTORE_DENTRO}')) return 'dentro';
  if (document.querySelector('${SELETTORE_FUORI}')) return 'fuori';
  return '';
})()`;

// "dentro" vince sempre; "fuori" vale solo se resta tale per qualche secondo:
// l'intestazione arriva prima del contenuto, e per un attimo anche da
// collegati può mostrare il pulsante di accesso.
async function statoAccesso(win: BrowserWindow, timeoutMs = 20_000): Promise<'dentro' | 'fuori' | null> {
  const fine = Date.now() + timeoutMs;
  let fuoriDal: number | null = null;
  while (Date.now() < fine) {
    const stato = await js<string>(win, CODICE_STATO_ACCESSO).catch(() => '');
    if (stato === 'dentro') return 'dentro';
    if (stato === 'fuori') {
      fuoriDal ??= Date.now();
      if (Date.now() - fuoriDal > 5_000) return 'fuori';
    } else {
      fuoriDal = null;
    }
    await pausa(300);
  }
  return fuoriDal !== null ? 'fuori' : null;
}

async function trovaFrameLogin(win: BrowserWindow, timeoutMs: number): Promise<WebFrameMain | null> {
  const fine = Date.now() + timeoutMs;
  while (Date.now() < fine) {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        if (await frame.executeJavaScript(`!!document.querySelector('input[type="password"]')`)) return frame;
      } catch {
        // Frame in caricamento o già sostituito.
      }
    }
    await pausa(300);
  }
  return null;
}

class ErroreDejure extends Error {}

async function eseguiLogin(win: BrowserWindow, cred: Credenziali): Promise<void> {
  await caricaPagina(win, `${BASE}/`);
  const stato = await statoAccesso(win);
  if (stato === 'dentro') return;
  if (stato !== 'fuori') throw new ErroreDejure('DeJure non risponde. Controlla la connessione e riprova.');

  // Banner dei cookie: si rifiutano quelli facoltativi, come farebbe l'avvocato.
  await js(win, `(() => {
    const b = document.getElementById('onetrust-reject-all-handler')
      || [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Rifiuta tutti');
    b?.click();
    return true;
  })()`);
  await js(win, `(document.querySelector('img[alt="Login"]') || document.querySelector('.gfl-hf-res-login'))?.closest('a')?.click(); true`);

  const frame = await trovaFrameLogin(win, 15_000);
  if (!frame) throw new ErroreDejure('Non trovo il modulo di accesso di DeJure. Il sito potrebbe essere cambiato.');

  // Valori impostati con il setter nativo + eventi input/change: il modulo
  // li legge come se fossero stati digitati.
  const compilato = await frame.executeJavaScript(`(() => {
    const imposta = (el, valore) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, valore);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Id del modulo SSO Giuffrè (cliente.giuffre.it/logingfl), con una
    // ricerca generica di riserva se dovessero cambiare.
    const password = document.getElementById('edit-password') || document.querySelector('input[type="password"]');
    const utente = document.getElementById('edit-ssousername')
      || [...document.querySelectorAll('input')].find((i) => i !== password && /^(text|email)$/.test(i.type));
    const pulsante = document.getElementById('edit-submit')
      || [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
        .find((b) => (b.value || b.textContent || '').trim().toLowerCase() === 'login');
    if (!utente || !password || !pulsante) return false;
    imposta(utente, ${JSON.stringify(cred.utente)});
    imposta(password, ${JSON.stringify(cred.password)});
    pulsante.click();
    return true;
  })()`);
  if (!compilato) throw new ErroreDejure('Non trovo il modulo di accesso di DeJure. Il sito potrebbe essere cambiato.');

  // Esito: o compare l'utente collegato nella pagina, o il modulo mostra un
  // errore (credenziali sbagliate). Il messaggio d'errore esatto del sito non
  // è noto in anticipo: si legge il testo visibile del modulo dopo l'invio.
  const fine = Date.now() + 25_000;
  while (Date.now() < fine) {
    await pausa(500);
    const ora = await js<string>(win, CODICE_STATO_ACCESSO).catch(() => '');
    if (ora === 'dentro') return;
    const erroreModulo = await frame
      .executeJavaScript(`(() => {
        const t = document.body.innerText.toLowerCase();
        return /(errat|non valid|non corrett|incorrect|invalid|bloccat)/.test(t) ? document.body.innerText.trim().slice(0, 200) : '';
      })()`)
      .catch(() => '');
    if (erroreModulo) throw new ErroreDejure('DeJure non ha accettato utente e password. Controllali e riprova.');
  }
  throw new ErroreDejure('Accesso a DeJure non riuscito nei tempi previsti. Riprova tra qualche minuto.');
}

// Apre un URL di DeJure da collegati: se la sessione è scaduta rifà il login
// con le credenziali salvate e riprova una volta.
async function apriDaCollegato(win: BrowserWindow, url: string): Promise<void> {
  await caricaPagina(win, url);
  if ((await statoAccesso(win)) === 'dentro') return;
  const cred = await leggiCredenziali();
  if (!cred) throw new ErroreDejure('DeJure non è collegato. Collegalo da Impostazioni → Integrazioni.');
  await eseguiLogin(win, cred);
  await caricaPagina(win, url);
  if ((await statoAccesso(win)) !== 'dentro') {
    throw new ErroreDejure("Non riesco a restare collegato a DeJure. Ricollegalo da Impostazioni → Integrazioni.");
  }
}

// ─── Ricerca e lettura ──────────────────────────────────────────────────

export type CategoriaDejure = 'giurisprudenza';

export interface RisultatoDejure {
  id: string;
  estremi: string;
  titolo: string;
  materia: string;
}

export interface RicercaDejure {
  risultati: RisultatoDejure[];
  conteggi: string;
}

export function cercaDejure(testo: string, massimo: number, categoria: CategoriaDejure = 'giurisprudenza'): Promise<RicercaDejure> {
  return inCoda(async () => {
    const win = apriFinestra();
    const url = `${BASE}/ricerca?searchText=${encodeURIComponent(testo).replace(/%20/g, '+')}&categoria=${categoria}`;
    await apriDaCollegato(win, url);

    // I risultati arrivano dopo la pagina: si aspettano le schede, oppure la
    // conferma che la ricerca non ha prodotto nulla.
    const pronto = await attendi<string>(
      win,
      `document.querySelector('.contenuto-ricerca-articoli') ? 'risultati'
        : (/nessun (risultato|documento)/i.test(document.body.innerText) ? 'vuoto' : '')`,
      25_000,
    );
    if (!pronto) throw new ErroreDejure('DeJure non ha restituito risultati nei tempi previsti. Riprova.');
    if (pronto === 'vuoto') return { risultati: [], conteggi: '' };
    await pausa(600); // le schede si completano a blocchi

    return js<RicercaDejure>(
      win,
      `(() => {
        const schede = [...document.querySelectorAll('.contenuto-ricerca-articoli')].slice(0, ${Math.max(1, Math.min(20, massimo))});
        const risultati = schede.map((s) => {
          const link = s.querySelector('.titolo-portali-ricerca a, a[href*="/dettaglio/"]');
          const id = (link?.getAttribute('href') || '').match(/dettaglio\\/(\\d+)/)?.[1] || '';
          return {
            id,
            estremi: (s.querySelector('.descrizione-articolo-ricerca')?.innerText || '').trim(),
            titolo: (link?.innerText || '').trim(),
            materia: (s.querySelector('.testo-libri')?.innerText || '').trim(),
          };
        }).filter((r) => r.id);
        // Riepilogo per tipo di fonte ("57 Massime", "185 Sentenze Cassazione Civile"...),
        // utile a Claude per capire quanto è ampio il tema.
        const testo = document.body.innerText;
        const inizio = testo.indexOf('Sinonimi suggeriti');
        const fine = testo.indexOf('Pertinenza:');
        const conteggi = inizio >= 0 && fine > inizio
          ? testo.slice(inizio + 'Sinonimi suggeriti'.length, fine).trim().split('\\n').reduce((acc, riga, i, righe) => {
              if (/^[\\d.]+$/.test(riga.trim()) && righe[i + 1]) acc.push(riga.trim() + ' ' + righe[i + 1].trim());
              return acc;
            }, []).join(' · ')
          : '';
        return { risultati, conteggi };
      })()`,
    );
  });
}

export interface DocumentoDejure {
  id: string;
  titolo: string;
  testo: string;
  idTestoIntegrale: string | null;
  troncato: boolean;
}

export function leggiDejure(id: string, testoIntegrale: boolean): Promise<DocumentoDejure> {
  return inCoda(async () => {
    const win = apriFinestra();
    await apriDaCollegato(win, `${BASE}/dettaglio/${id}?categoria=giurisprudenza`);
    const pronto = await attendi<boolean>(win, `!!document.querySelector('.titolo-dettaglio')`, 25_000);
    if (!pronto) throw new ErroreDejure('Non riesco ad aprire questo documento su DeJure.');
    await pausa(500);

    // Dalla massima, il pulsante "Sentenza" porta al testo integrale (un
    // altro documento, con un suo id).
    if (testoIntegrale) {
      const idPrima = id;
      const cliccato = await js<boolean>(
        win,
        `(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Sentenza');
          if (!b || b.disabled || b.classList.contains('v-btn--disabled')) return false;
          b.click();
          return true;
        })()`,
      );
      if (cliccato) {
        await attendi<boolean>(win, `!location.pathname.endsWith('/${idPrima}')`, 15_000);
        await attendi<boolean>(win, `!!document.querySelector('.titolo-dettaglio, .tipoud-main-col')`, 20_000);
        await pausa(800);
      }
    }

    const doc = await js<{ id: string; titolo: string; testo: string; haSentenza: boolean }>(
      win,
      `(() => {
        const id = (location.pathname.match(/dettaglio\\/(\\d+)/) || [])[1] || '';
        const titolo = [document.querySelector('.sopratitolo-dettaglio')?.innerText, document.querySelector('.titolo-dettaglio')?.innerText]
          .filter(Boolean).map((t) => t.trim()).join(' — ');
        // Sentenza integrale: le sezioni (Intestazione, Fatto, Diritto, P.Q.M.)
        // stanno in .tipoud-main-col. Massima: si prende il corpo della pagina
        // tra il titolo e la barra degli strumenti ("Appunta", "Stampa"...).
        const sezioni = [...document.querySelectorAll('.tipoud-main-col')].map((e) => e.innerText.trim()).filter(Boolean);
        let testo;
        if (sezioni.length) {
          testo = sezioni.join('\\n\\n');
        } else {
          const tutto = document.body.innerText;
          const titoloBreve = (document.querySelector('.titolo-dettaglio')?.innerText || '').trim();
          const da = titoloBreve ? tutto.indexOf(titoloBreve) : 0;
          const a = tutto.indexOf('\\nAppunta\\nStampa');
          testo = tutto.slice(Math.max(0, da), a > da ? a : undefined).trim();
        }
        const haSentenza = [...document.querySelectorAll('button')].some((x) => x.innerText.trim() === 'Sentenza' && !x.classList.contains('v-btn--disabled'));
        return { id, titolo, testo, haSentenza };
      })()`,
    );

    const troncato = doc.testo.length > LUNGHEZZA_MAX_TESTO;
    return {
      id: doc.id || id,
      titolo: doc.titolo,
      testo: troncato ? doc.testo.slice(0, LUNGHEZZA_MAX_TESTO) : doc.testo,
      idTestoIntegrale: !testoIntegrale && doc.haSentenza ? id : null,
      troncato,
    };
  });
}

// ─── Collegamento da Impostazioni ───────────────────────────────────────

async function collega(cred: Credenziali): Promise<StatoDejure> {
  // Si parte da una sessione pulita: un login vecchio di un altro utente non
  // deve far sembrare valide credenziali nuove sbagliate.
  await scollegaSessione();
  await inCoda(async () => {
    const win = apriFinestra();
    await eseguiLogin(win, cred);
  });
  await salvaCredenziali(cred);
  const ora = new Date().toISOString();
  const stato: StatoSalvato = { utente: cred.utente, avvertenzaAccettataIl: ora, collegatoIl: ora };
  await fs.writeFile(STATO_PATH(), JSON.stringify(stato), 'utf-8');
  return statoDejure();
}

async function scollegaSessione(): Promise<void> {
  chiudiFinestra();
  await session.fromPartition(PARTIZIONE).clearStorageData();
}

async function scollega(): Promise<void> {
  await scollegaSessione();
  await fs.unlink(CREDENZIALI_PATH()).catch(() => undefined);
  await fs.unlink(STATO_PATH()).catch(() => undefined);
}

const collegaSchema = z.object({
  utente: z.string().trim().min(3),
  password: z.string().min(1),
  avvertenzaAccettata: z.literal(true),
});

export function registraDejure(): void {
  ipcMain.handle('dejure:stato', async () => statoDejure());

  ipcMain.handle('dejure:collega', async (_event, input: unknown) => {
    const { utente, password } = collegaSchema.parse(input);
    try {
      return { ok: true as const, stato: await collega({ utente, password }) };
    } catch (err) {
      await scollegaSessione().catch(() => undefined);
      return { ok: false as const, errore: err instanceof ErroreDejure ? err.message : 'Collegamento a DeJure non riuscito. Riprova.' };
    }
  });

  ipcMain.handle('dejure:scollega', async () => scollega());
}

// ─── Strumenti per Claude ───────────────────────────────────────────────

function messaggioErrore(err: unknown): string {
  return err instanceof ErroreDejure ? err.message : 'DeJure non è raggiungibile in questo momento.';
}

export function creaServerDejure(): McpSdkServerConfigWithInstance {
  let consultazioni = 0;
  const limiteRaggiunto = () => ({
    content: [
      {
        type: 'text' as const,
        text: `Limite di ${CONSULTAZIONI_MAX_PER_DOMANDA} consultazioni DeJure per questa domanda raggiunto: rispondi con quanto già trovato.`,
      },
    ],
  });

  const cerca = tool(
    'cerca_dejure',
    'Cerca giurisprudenza (massime e sentenze) nella banca dati DeJure dello studio. Usa poche parole chiave giuridiche precise (es. "ammortamento alla francese nullità", "art. 2051 c.c. caso fortuito"). Restituisce estremi, titolo/principio e id di ciascun documento, da leggere con leggi_dejure.',
    {
      testo: z.string().min(2).describe('Parole chiave della ricerca'),
      massimo: z.number().int().min(1).max(20).optional().describe('Numero massimo di risultati (default 10)'),
    },
    async ({ testo, massimo }) => {
      if (++consultazioni > CONSULTAZIONI_MAX_PER_DOMANDA) return limiteRaggiunto();
      try {
        const { risultati, conteggi } = await cercaDejure(testo, massimo ?? 10);
        if (!risultati.length) return { content: [{ type: 'text' as const, text: `Nessun risultato su DeJure per «${testo}».` }] };
        const righe = risultati.map((r, i) => `${i + 1}. [id ${r.id}] ${r.estremi}\n   ${r.titolo}${r.materia ? `\n   Materia: ${r.materia}` : ''}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Risultati DeJure per «${testo}»${conteggi ? ` (totali: ${conteggi})` : ''}:\n\n${righe.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: messaggioErrore(err) }], isError: true };
      }
    },
  );

  const leggi = tool(
    'leggi_dejure',
    'Apre un documento DeJure trovato con cerca_dejure: di default la massima (principio, fonte, norme citate); con testo_integrale=true la sentenza completa (fatto, diritto, dispositivo). Leggi il testo integrale solo quando serve davvero la motivazione.',
    {
      id: z.string().regex(/^\d+$/).describe('Id del documento restituito da cerca_dejure'),
      testo_integrale: z.boolean().optional().describe('true per la sentenza completa invece della massima'),
    },
    async ({ id, testo_integrale }) => {
      if (++consultazioni > CONSULTAZIONI_MAX_PER_DOMANDA) return limiteRaggiunto();
      try {
        const doc = await leggiDejure(id, testo_integrale ?? false);
        const note = [
          doc.idTestoIntegrale ? `Testo integrale disponibile: leggi_dejure con id ${doc.idTestoIntegrale} e testo_integrale=true.` : null,
          doc.troncato ? `(Testo troncato a ${LUNGHEZZA_MAX_TESTO} caratteri.)` : null,
        ].filter(Boolean);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Fonte: DeJure — ${doc.titolo}\n\n${doc.testo}${note.length ? `\n\n${note.join('\n')}` : ''}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: messaggioErrore(err) }], isError: true };
      }
    },
  );

  return createSdkMcpServer({ name: 'jarai-dejure', tools: [cerca, leggi] });
}

export const STRUMENTI_DEJURE = ['mcp__jarai-dejure__cerca_dejure', 'mcp__jarai-dejure__leggi_dejure'];

export const PROMPT_DEJURE = `
Lo studio ha collegato la banca dati DeJure: quando la domanda richiede giurisprudenza (orientamenti, massime,
precedenti) cercala con cerca_dejure usando poche parole chiave giuridiche precise, poi apri con leggi_dejure
solo i documenti pertinenti (la massima basta quasi sempre; il testo integrale solo se serve la motivazione).
Non attribuire mai a una pronuncia un principio che non hai letto. Cita sempre gli estremi completi (autorità,
sezione, data, numero) indicando che la fonte è DeJure, e tieni distinte le pronunce di legittimità da quelle
di merito. Al massimo ${CONSULTAZIONI_MAX_PER_DOMANDA} consultazioni per domanda: ricerche mirate, non esplorazioni.`;
