import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { BASE_DEJURE, ClienteDejure, ErroreDejure, type CredenzialiDejure, type PaginaWeb } from '../core/dejure';

// DeJure per l'assistente di riserva (JarAI Server): lo stesso codice del
// computer (src/core/dejure.ts) su un Chromium headless nel container.
// Le credenziali arrivano nel pacchetto cifrato dello studio e stanno solo in
// memoria; il profilo del browser (cookie della sessione DeJure) sta in una
// cartella in RAM. Tutto si chiude quando il server dimentica la chiave, e
// dopo qualche minuto senza consultazioni.

const INATTIVITA_MS = 5 * 60_000;
const CARICAMENTO_MS = 30_000;

export interface OpzioniDejureServer {
  /** Eseguibile di Chromium (nell'immagine: /usr/bin/chromium). */
  eseguibile: string;
  /** Cartella in RAM per il profilo del browser. */
  cartella: string;
  registraErrore?: (contesto: string, dettaglio: string) => void;
  /** Per le prove: un DeJure finto. */
  base?: string;
  /** Per le prove: al posto di puppeteer. */
  avvia?: (opzioni: { executablePath: string; userDataDir: string; args: string[]; env: Record<string, string | undefined> }) => Promise<Browser>;
}

export class DejureServer {
  private credenziali: CredenzialiDejure | null = null;
  private browser: Promise<{ browser: Browser; pagina: Page; profilo: string }> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly chiusi = new WeakSet<Browser>();
  readonly cliente: ClienteDejure;

  constructor(private readonly o: OpzioniDejureServer) {
    this.cliente = new ClienteDejure({
      pagina: () => this.pagina(),
      credenziali: async () => this.credenziali,
      senzaCredenziali: 'DeJure non è collegato sul computer dello studio.',
      base: o.base,
    });
  }

  /** Dal pacchetto dello studio, appena decifrato. null: DeJure non collegato. */
  imposta(credenziali: CredenzialiDejure | null): void {
    const prima = this.credenziali;
    this.credenziali = credenziali ? { ...credenziali } : null;
    // Utente cambiato: la sessione aperta è di un altro.
    if (prima && prima.utente !== credenziali?.utente) void this.chiudi();
  }

  /** Credenziali presenti e sito che accetta questo server (vedi verificaAccesso). */
  get disponibile(): boolean {
    return !!this.credenziali && this.accettato !== false;
  }

  private accettato: boolean | null = null;

  /**
   * DeJure rifiuta (403) i collegamenti da alcuni indirizzi, per esempio
   * quelli dei datacenter: se rifiuta questo server, l'assistente non riceve
   * gli strumenti DeJure. Una sola richiesta alla pagina iniziale, senza login.
   */
  async verificaAccesso(): Promise<boolean | null> {
    try {
      const r = await fetch(`${this.o.base ?? BASE_DEJURE}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      this.accettato = r.status !== 403;
    } catch {
      this.accettato = null; // rete assente: si riprova, intanto non si esclude
    }
    return this.accettato;
  }

  /** Dimentica credenziali e sessione DeJure. */
  async dimentica(): Promise<void> {
    this.credenziali = null;
    await this.chiudi();
  }

  private async pagina(): Promise<PaginaWeb> {
    this.rinvia();
    this.browser ??= this.avvia().catch((err) => {
      this.browser = null;
      this.o.registraErrore?.('dejure', err instanceof Error ? err.message : String(err));
      throw err;
    });
    const { pagina } = await this.browser;
    return paginaPuppeteer(pagina);
  }

  private async avvia(): Promise<{ browser: Browser; pagina: Page; profilo: string }> {
    const profilo = await mkdtemp(join(this.o.cartella, 'jarai-dejure-'));
    const opzioni = {
      executablePath: this.o.eseguibile,
      userDataDir: profilo,
      // Root del container in sola lettura: Chromium scrive solo nel profilo in RAM.
      env: { PATH: process.env.PATH, HOME: profilo, XDG_CONFIG_HOME: profilo, XDG_CACHE_HOME: profilo, TZ: process.env.TZ, LANG: 'it_IT.UTF-8' },
      args: [
        // Nel container: niente sandbox di Chromium (servirebbero privilegi che
        // il container non ha); l'isolamento è quello del container, che apre
        // solo DeJure.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--lang=it-IT',
        '--window-size=1280,900',
      ],
    };
    const browser = this.o.avvia
      ? await this.o.avvia(opzioni)
      : await (await import('puppeteer-core')).launch({ ...opzioni, headless: true, defaultViewport: { width: 1280, height: 900 } });
    const pagina = (await browser.pages())[0] ?? (await browser.newPage());
    // Lo user agent headless dice "HeadlessChrome": si presenta come il Chrome che è.
    await pagina.setUserAgent({ userAgent: (await browser.userAgent()).replace('HeadlessChrome', 'Chrome') });
    await pagina.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
    pagina.setDefaultTimeout(CARICAMENTO_MS);
    // Niente finestre nuove: DeJure resta sulla sua pagina.
    browser.on('targetcreated', (t) => {
      if (t.type() === 'page') void t.page().then((p) => (p && p !== pagina ? p.close() : undefined));
    });
    // Chromium caduto da sé (non chiuso da qui): si riparte alla prossima consultazione.
    browser.on('disconnected', () => {
      if (this.chiusi.has(browser)) return;
      this.browser = null;
      void cancella(profilo);
    });
    return { browser, pagina, profilo };
  }

  private rinvia(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.chiudi(), INATTIVITA_MS);
    this.timer.unref?.();
  }

  private async chiudi(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const b = this.browser;
    this.browser = null;
    if (!b) return;
    const aperto = await b.catch(() => null);
    if (!aperto) return;
    this.chiusi.add(aperto.browser);
    await aperto.browser.close().catch(() => undefined);
    await cancella(aperto.profilo);
  }
}

export const BLOCCATO =
  "DeJure non accetta collegamenti dal server dello studio. Per la giurisprudenza su DeJure serve il computer dello studio acceso: dillo all'avvocato.";

// Chromium può scrivere nel profilo ancora per un attimo dopo la chiusura.
const cancella = (cartella: string) => rm(cartella, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);

export function paginaPuppeteer(pagina: Page): PaginaWeb {
  return {
    carica: async (url) => {
      let risposta;
      try {
        risposta = await pagina.goto(url, { waitUntil: 'load', timeout: CARICAMENTO_MS });
      } catch (err) {
        // Come sul computer: le SPA annullano il primo caricamento con un
        // redirect interno; una pagina lenta si controlla dopo, dal contenuto.
        if (!/ERR_ABORTED|frame was detached|Navigation timeout/i.test(String(err))) throw err;
      }
      // DeJure rifiuta i collegamenti da alcuni indirizzi (datacenter): lo si
      // dice subito, invece di aspettare una pagina che non arriverà.
      if (risposta?.status() === 403) {
        throw new ErroreDejure(BLOCCATO);
      }
    },
    valuta: <T>(codice: string) => pagina.evaluate(codice) as Promise<T>,
    frame: () => pagina.frames().map((f) => ({ valuta: <T>(codice: string) => f.evaluate(codice) as Promise<T> })),
  };
}
