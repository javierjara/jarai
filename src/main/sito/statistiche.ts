import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { URL_PROXY, leggiLicenza } from '../licenza';
import { ErroreSito } from './payload';

// Statistiche dello Studio digitale, entrambe lette dal proxy JarAI e solo
// per il sito registrato nel CRM per la licenza: l'avvocato non configura nulla.
//  - Google (clic, volte in Google, posizione, ricerche): Search Console,
//    con l'account di servizio di JarAI (jarai-proxy/src/gsc.ts).
//  - Visite: botcom analytics, cioè Umami installato da Botcom, senza cookie
//    e senza banner (jarai-proxy/src/visite.ts).

export interface DatiGoogle {
  proprieta: string;
  periodo: { da: string; a: string };
  totali: Totali;
  precedenti: Totali;
  giorni: { data: string; clic: number; impressioni: number }[];
  pagine: { url: string; clic: number; impressioni: number; posizione: number }[];
  ricerche: { ricerca: string; url: string; clic: number; impressioni: number; posizione: number }[];
}

interface Totali {
  clic: number;
  impressioni: number;
  ctr: number;
  posizione: number;
}

export interface DatiVisite {
  totale: number;
  precedente: number;
  giorni: { data: string; visite: number }[];
  perPagina: { percorso: string; visite: number; precedenti: number }[];
}

export interface Statistiche {
  giorni: number;
  google: DatiGoogle | null;
  erroreGoogle?: { messaggio: string; codice?: string; account?: string };
  visite: DatiVisite | null;
  erroreVisite?: string;
}

// Le versioni precedenti salvavano qui la chiave di Umami Cloud inserita
// dall'avvocato: non serve più e non deve restare sul computer.
export async function rimuoviVecchiaChiaveUmami(): Promise<void> {
  await fs.unlink(join(app.getPath('userData'), 'sito-umami.enc')).catch(() => undefined);
}

type ErroreProxy = ErroreSito & { codice?: string; account?: string };

// GET al proxy con la licenza; gli errori del proxy (messaggio e codice) arrivano all'interfaccia.
async function dalProxy<T>(percorso: string, nome: string): Promise<T> {
  const chiave = await leggiLicenza();
  if (!chiave) throw new ErroreSito(`Serve una licenza JarAI attiva per le ${nome}.`);
  let risposta: Response;
  try {
    risposta = await fetch(`${URL_PROXY}${percorso}`, {
      headers: { 'x-api-key': chiave },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ErroreSito(`Non riesco a leggere le ${nome}. Controlla la connessione.`);
  }
  const dati = (await risposta.json().catch(() => null)) as (T & { error?: string; codice?: string; account?: string }) | null;
  if (!risposta.ok || !dati) {
    const err = new ErroreSito(dati?.error ?? `${nome[0].toUpperCase()}${nome.slice(1)} non disponibili in questo momento.`) as ErroreProxy;
    err.codice = dati?.codice;
    err.account = dati?.account;
    throw err;
  }
  return dati;
}

async function visite(giorni: number): Promise<DatiVisite> {
  const d = await dalProxy<DatiVisite>(`/v1/visite?days=${giorni}`, 'statistiche delle visite');
  return { totale: d.totale, precedente: d.precedente, giorni: d.giorni, perPagina: d.perPagina };
}

// ─── Google (tramite il proxy) ──────────────────────────────────────────

async function google(giorni: number): Promise<DatiGoogle> {
  return dalProxy<DatiGoogle>(`/v1/search-console?days=${giorni}`, 'statistiche Google');
}

let cache: { chiave: string; dati: Statistiche; scade: number } | null = null;

export async function leggiStatistiche(giorni: number, forza = false): Promise<Statistiche> {
  const chiave = String(giorni);
  if (!forza && cache?.chiave === chiave && cache.scade > Date.now()) return cache.dati;
  const [g, v] = await Promise.allSettled([google(giorni), visite(giorni)]);
  const dati: Statistiche = {
    giorni,
    google: g.status === 'fulfilled' ? g.value : null,
    visite: v.status === 'fulfilled' ? v.value : null,
  };
  if (g.status === 'rejected') {
    const e = g.reason as ErroreSito & { codice?: string; account?: string };
    dati.erroreGoogle = {
      messaggio: e instanceof ErroreSito ? e.message : 'Statistiche Google non disponibili.',
      codice: e.codice,
      account: e.account,
    };
  }
  if (v.status === 'rejected') {
    dati.erroreVisite = v.reason instanceof ErroreSito ? v.reason.message : 'Visite non disponibili.';
  }
  cache = { chiave, dati, scade: Date.now() + 15 * 60_000 };
  return dati;
}

// Per l'assistente: ricerche in cui il sito compare ma non in prima
// pagina, utili per proporre idee. Dati aggregati di Google, nessun dato di
// persone.
export async function opportunitaGoogle(): Promise<string> {
  const stat = await leggiStatistiche(28);
  if (!stat.google) return stat.erroreGoogle?.messaggio ?? 'Statistiche Google non disponibili.';
  const righe = stat.google.ricerche
    .filter((r) => r.posizione > 7 && r.impressioni >= 20)
    .sort((a, b) => b.impressioni - a.impressioni)
    .slice(0, 25)
    .map((r) => `- «${r.ricerca}» · ${r.impressioni} volte in Google · posizione ${r.posizione.toFixed(1)} · pagina ${r.url}`);
  return righe.length
    ? `Ricerche degli ultimi 28 giorni in cui il sito compare ma non in prima pagina:\n${righe.join('\n')}`
    : 'Nessuna ricerca con abbastanza dati negli ultimi 28 giorni.';
}
