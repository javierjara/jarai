import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Integrazione DeJure (Lefebvre Giuffrè), indipendente dal browser che la
// esegue. DeJure non offre un'API: JarAI apre il sito con le credenziali
// dell'avvocato e ne legge le pagine di ricerca e di dettaglio come farebbe
// lui. Il browser cambia:
//  - sul computer, una finestra nascosta di Electron (src/main/dejure.ts);
//  - sul server privato, un Chromium headless (src/server/dejure.ts), per
//    l'assistente di riserva a computer spento.
// Qui stanno login, ricerca, lettura e gli strumenti per Claude: stessi
// selettori e stesse regole (una richiesta alla volta, tetto per domanda).

export const BASE_DEJURE = 'https://dejure.lefebvregiuffre.it';

// Consultazioni DeJure (ricerche + letture) per singola domanda all'assistente.
export const CONSULTAZIONI_MAX_PER_DOMANDA = 15;
const LUNGHEZZA_MAX_TESTO = 60_000;

export interface CredenzialiDejure {
  utente: string;
  password: string;
}

/** Il minimo che serve di un browser: una pagina, il suo JavaScript, i suoi frame. */
export interface PaginaWeb {
  /** Naviga e aspetta il caricamento; gli annullamenti da redirect interno non sono errori. */
  carica(url: string): Promise<void>;
  valuta<T>(codice: string): Promise<T>;
  /** Tutti i frame della pagina (principale compreso). */
  frame(): Array<{ valuta<T>(codice: string): Promise<T> }>;
}

export class ErroreDejure extends Error {}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export interface DocumentoDejure {
  id: string;
  titolo: string;
  testo: string;
  idTestoIntegrale: string | null;
  troncato: boolean;
}

export type CategoriaDejure = 'giurisprudenza';

export interface OpzioniClienteDejure {
  /** La pagina su cui lavorare (aperta o riaperta da chi la fornisce). */
  pagina: () => Promise<PaginaWeb>;
  /** Credenziali per rifare il login quando la sessione scade. */
  credenziali: () => Promise<CredenzialiDejure | null>;
  /** Messaggio quando mancano le credenziali (dipende da dove gira). */
  senzaCredenziali?: string;
  /** Per le prove: un DeJure finto. */
  base?: string;
}

export class ClienteDejure {
  private coda: Promise<unknown> = Promise.resolve();

  private readonly base: string;

  constructor(private readonly o: OpzioniClienteDejure) {
    this.base = o.base ?? BASE_DEJURE;
  }

  // Una richiesta alla volta sulla stessa pagina: due ricerche in parallelo
  // si pesterebbero i piedi e sembrerebbero un uso anomalo.
  private inCoda<T>(lavoro: () => Promise<T>): Promise<T> {
    const risultato = this.coda.then(lavoro, lavoro);
    this.coda = risultato.catch(() => undefined);
    return risultato;
  }

  /** Login esplicito (collegamento da Impostazioni): errore se non riesce. */
  accedi(cred: CredenzialiDejure): Promise<void> {
    return this.inCoda(async () => eseguiLogin(await this.o.pagina(), cred, this.base));
  }

  cerca(testo: string, massimo: number, categoria: CategoriaDejure = 'giurisprudenza'): Promise<RicercaDejure> {
    return this.inCoda(async () => {
      const p = await this.o.pagina();
      const url = `${this.base}/ricerca?searchText=${encodeURIComponent(testo).replace(/%20/g, '+')}&categoria=${categoria}`;
      await this.apriDaCollegato(p, url);

      // I risultati arrivano dopo la pagina: si aspettano le schede, oppure la
      // conferma che la ricerca non ha prodotto nulla.
      const pronto = await attendi<string>(
        p,
        `document.querySelector('.contenuto-ricerca-articoli') ? 'risultati'
          : (/nessun (risultato|documento)/i.test(document.body.innerText) ? 'vuoto' : '')`,
        25_000,
      );
      if (!pronto) throw new ErroreDejure('DeJure non ha restituito risultati nei tempi previsti. Riprova.');
      if (pronto === 'vuoto') return { risultati: [], conteggi: '' };
      await pausa(600); // le schede si completano a blocchi

      return p.valuta<RicercaDejure>(
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

  leggi(id: string, testoIntegrale: boolean): Promise<DocumentoDejure> {
    return this.inCoda(async () => {
      const p = await this.o.pagina();
      await this.apriDaCollegato(p, `${this.base}/dettaglio/${id}?categoria=giurisprudenza`);
      const pronto = await attendi<boolean>(p, `!!document.querySelector('.titolo-dettaglio')`, 25_000);
      if (!pronto) throw new ErroreDejure('Non riesco ad aprire questo documento su DeJure.');
      await pausa(500);

      // Dalla massima, il pulsante "Sentenza" porta al testo integrale (un
      // altro documento, con un suo id).
      if (testoIntegrale) {
        const cliccato = await p.valuta<boolean>(
          `(() => {
            const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Sentenza');
            if (!b || b.disabled || b.classList.contains('v-btn--disabled')) return false;
            b.click();
            return true;
          })()`,
        );
        if (cliccato) {
          await attendi<boolean>(p, `!location.pathname.endsWith('/${id}')`, 15_000);
          await attendi<boolean>(p, `!!document.querySelector('.titolo-dettaglio, .tipoud-main-col')`, 20_000);
          await pausa(800);
        }
      }

      const doc = await p.valuta<{ id: string; titolo: string; testo: string; haSentenza: boolean }>(
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

  // Apre un URL di DeJure da collegati: se la sessione è scaduta rifà il login
  // con le credenziali salvate e riprova una volta.
  private async apriDaCollegato(p: PaginaWeb, url: string): Promise<void> {
    await p.carica(url);
    if ((await statoAccesso(p)) === 'dentro') return;
    const cred = await this.o.credenziali();
    if (!cred) throw new ErroreDejure(this.o.senzaCredenziali ?? 'DeJure non è collegato. Collegalo da Impostazioni → Integrazioni.');
    await eseguiLogin(p, cred, this.base);
    await p.carica(url);
    if ((await statoAccesso(p)) !== 'dentro') {
      throw new ErroreDejure('Non riesco a restare collegato a DeJure. Ricollegalo da Impostazioni → Integrazioni.');
    }
  }
}

async function attendi<T>(p: PaginaWeb, codice: string, timeoutMs: number): Promise<T | null> {
  const fine = Date.now() + timeoutMs;
  while (Date.now() < fine) {
    try {
      const valore = await p.valuta<T>(codice);
      if (valore) return valore;
    } catch {
      // Pagina in navigazione: si riprova al giro successivo.
    }
    await pausa(300);
  }
  return null;
}

// "dentro" vince sempre; "fuori" vale solo se resta tale per qualche secondo:
// l'intestazione arriva prima del contenuto, e per un attimo anche da
// collegati può mostrare il pulsante di accesso.
async function statoAccesso(p: PaginaWeb, timeoutMs = 20_000): Promise<'dentro' | 'fuori' | null> {
  const fine = Date.now() + timeoutMs;
  let fuoriDal: number | null = null;
  while (Date.now() < fine) {
    const stato = await p.valuta<string>(CODICE_STATO_ACCESSO).catch(() => '');
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

async function trovaFrameLogin(p: PaginaWeb, timeoutMs: number): Promise<ReturnType<PaginaWeb['frame']>[number] | null> {
  const fine = Date.now() + timeoutMs;
  while (Date.now() < fine) {
    for (const frame of p.frame()) {
      try {
        if (await frame.valuta<boolean>(`!!document.querySelector('input[type="password"]')`)) return frame;
      } catch {
        // Frame in caricamento o già sostituito.
      }
    }
    await pausa(300);
  }
  return null;
}

async function eseguiLogin(p: PaginaWeb, cred: CredenzialiDejure, base: string): Promise<void> {
  await p.carica(`${base}/`);
  const stato = await statoAccesso(p);
  if (stato === 'dentro') return;
  if (stato !== 'fuori') throw new ErroreDejure('DeJure non risponde. Controlla la connessione e riprova.');

  // Banner dei cookie: si rifiutano quelli facoltativi, come farebbe l'avvocato.
  await p.valuta(`(() => {
    const b = document.getElementById('onetrust-reject-all-handler')
      || [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Rifiuta tutti');
    b?.click();
    return true;
  })()`);
  await p.valuta(`(() => { (document.querySelector('img[alt="Login"]') || document.querySelector('.gfl-hf-res-login'))?.closest('a')?.click(); return true; })()`);

  const frame = await trovaFrameLogin(p, 15_000);
  if (!frame) throw new ErroreDejure('Non trovo il modulo di accesso di DeJure. Il sito potrebbe essere cambiato.');

  // Valori impostati con il setter nativo + eventi input/change: il modulo
  // li legge come se fossero stati digitati.
  const compilato = await frame.valuta<boolean>(`(() => {
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
    const ora = await p.valuta<string>(CODICE_STATO_ACCESSO).catch(() => '');
    if (ora === 'dentro') return;
    const erroreModulo = await frame
      .valuta<string>(`(() => {
        const t = document.body.innerText.toLowerCase();
        return /(errat|non valid|non corrett|incorrect|invalid|bloccat)/.test(t) ? document.body.innerText.trim().slice(0, 200) : '';
      })()`)
      .catch(() => '');
    if (erroreModulo) throw new ErroreDejure('DeJure non ha accettato utente e password. Controllali e riprova.');
  }
  throw new ErroreDejure('Accesso a DeJure non riuscito nei tempi previsti. Riprova tra qualche minuto.');
}

// ─── Strumenti per Claude ───────────────────────────────────────────────

function messaggioErrore(err: unknown): string {
  return err instanceof ErroreDejure ? err.message : 'DeJure non è raggiungibile in questo momento.';
}

/** Strumenti per una domanda: il conteggio delle consultazioni riparte a ogni chiamata. */
export function creaServerDejure(cliente: Pick<ClienteDejure, 'cerca' | 'leggi'>): McpSdkServerConfigWithInstance {
  let consultazioni = 0;
  const testo = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
  const limiteRaggiunto = () =>
    testo(`Limite di ${CONSULTAZIONI_MAX_PER_DOMANDA} consultazioni DeJure per questa domanda raggiunto: rispondi con quanto già trovato.`);

  const cerca = tool(
    'cerca_dejure',
    'Cerca giurisprudenza (massime e sentenze) nella banca dati DeJure dello studio. Usa poche parole chiave giuridiche precise (es. "ammortamento alla francese nullità", "art. 2051 c.c. caso fortuito"). Restituisce estremi, titolo/principio e id di ciascun documento, da leggere con leggi_dejure.',
    {
      testo: z.string().min(2).describe('Parole chiave della ricerca'),
      massimo: z.number().int().min(1).max(20).optional().describe('Numero massimo di risultati (default 10)'),
    },
    async ({ testo: chiave, massimo }) => {
      if (++consultazioni > CONSULTAZIONI_MAX_PER_DOMANDA) return limiteRaggiunto();
      try {
        const { risultati, conteggi } = await cliente.cerca(chiave, massimo ?? 10);
        if (!risultati.length) return testo(`Nessun risultato su DeJure per «${chiave}».`);
        const righe = risultati.map((r, i) => `${i + 1}. [id ${r.id}] ${r.estremi}\n   ${r.titolo}${r.materia ? `\n   Materia: ${r.materia}` : ''}`);
        return testo(`Risultati DeJure per «${chiave}»${conteggi ? ` (totali: ${conteggi})` : ''}:\n\n${righe.join('\n')}`);
      } catch (err) {
        return testo(messaggioErrore(err), true);
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
        const doc = await cliente.leggi(id, testo_integrale ?? false);
        const note = [
          doc.idTestoIntegrale ? `Testo integrale disponibile: leggi_dejure con id ${doc.idTestoIntegrale} e testo_integrale=true.` : null,
          doc.troncato ? `(Testo troncato a ${LUNGHEZZA_MAX_TESTO} caratteri.)` : null,
        ].filter(Boolean);
        return testo(`Fonte: DeJure — ${doc.titolo}\n\n${doc.testo}${note.length ? `\n\n${note.join('\n')}` : ''}`);
      } catch (err) {
        return testo(messaggioErrore(err), true);
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
