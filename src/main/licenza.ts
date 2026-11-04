import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { cartellaConfigurazioneClaude, leggiChiave } from './claudeAuth';

// Licenza JarAI (jarai-proxy): lo studio incolla una chiave "jarai_..." e
// JarAI parla con Claude attraverso il proxy, che tiene la vera chiave
// Anthropic e applica il limite di domande del mese. Nessun account Claude
// e nessuna chiave API sul PC dello studio.
//
// JARAI_PROXY_URL serve solo in sviluppo (wrangler dev in locale).
export const URL_PROXY = process.env.JARAI_PROXY_URL ?? 'https://jarai-proxy.jarai-antonio.workers.dev';

// Cifrata come la chiave dello studio (claudeAuth.ts): safeStorage, solo
// nella cartella dati dell'app.
const LICENZA_PATH = () => join(app.getPath('userData'), 'jarai-licenza.enc');

export async function leggiLicenza(): Promise<string | null> {
  try {
    const cifrata = await fs.readFile(LICENZA_PATH());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(cifrata);
  } catch {
    return null;
  }
}

async function scriviLicenza(licenza: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('La cifratura del sistema non è disponibile su questo computer.');
  }
  await fs.writeFile(LICENZA_PATH(), safeStorage.encryptString(licenza));
}

export async function rimuoviLicenza(): Promise<void> {
  try {
    await fs.unlink(LICENZA_PATH());
  } catch {
    // Nessuna licenza salvata: nulla da rimuovere.
  }
}

export interface StatoLicenza {
  valida: boolean;
  messaggio?: string;
  studio?: string;
  piano?: string;
  domandeUsate?: number;
  domandeMese?: number;
  /** Funzioni aggiuntive attivate dal CRM per lo studio (es. "studio_digitale"). */
  funzioni?: string[];
}

// Chiede lo stato al proxy (GET /v1/license): non passa da Claude e non
// consuma domande, quindi si può chiamare a ogni verifica.
export async function statoLicenza(licenza?: string | null): Promise<StatoLicenza> {
  const chiave = licenza ?? (await leggiLicenza());
  if (!chiave) return { valida: false, messaggio: 'Nessuna licenza JarAI inserita.' };
  try {
    const risposta = await fetch(`${URL_PROXY}/v1/license`, { headers: { 'x-api-key': chiave } });
    if (risposta.status === 401) {
      return { valida: false, messaggio: 'Licenza JarAI non valida, sospesa o scaduta.' };
    }
    if (!risposta.ok) return { valida: false, messaggio: 'Il servizio JarAI non risponde. Riprova tra poco.' };
    const dati = (await risposta.json()) as { customerName: string; plan: string; monthlyLimit: number; count: number; features?: string[] };
    return {
      valida: true,
      studio: dati.customerName,
      piano: dati.plan,
      domandeUsate: dati.count,
      domandeMese: dati.monthlyLimit,
      funzioni: Array.isArray(dati.features) ? dati.features : [],
    };
  } catch {
    return { valida: false, messaggio: 'Non riesco a raggiungere il servizio JarAI. Controlla la connessione.' };
  }
}

// Si salva solo una licenza che il proxy riconosce: una chiave sbagliata non
// deve sostituire quella buona già presente.
export async function attivaLicenza(licenza: string): Promise<StatoLicenza> {
  const stato = await statoLicenza(licenza.trim());
  if (stato.valida) await scriviLicenza(licenza.trim());
  return stato;
}

// Ambiente per claude.exe, uguale per chat, verifica e utilizzo. La licenza
// ha la precedenza sulla chiave dello studio e sul login con l'account.
// `domandaId`: lo stesso per tutte le chiamate di una domanda in chat, così
// il proxy conta domande e non chiamate API.
export async function ambienteClaude(domandaId?: string): Promise<Record<string, string | undefined>> {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude() };
  const licenza = await leggiLicenza();
  if (licenza) {
    return {
      ...base,
      ANTHROPIC_BASE_URL: URL_PROXY,
      ANTHROPIC_API_KEY: licenza,
      ...(domandaId ? { ANTHROPIC_CUSTOM_HEADERS: `X-Question-Id: ${domandaId}` } : {}),
      // Telemetria e aggiornamenti di claude.exe non devono uscire verso
      // altri servizi: con la licenza tutto passa solo dal proxy.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }
  const chiave = await leggiChiave();
  return chiave ? { ...base, ANTHROPIC_API_KEY: chiave } : base;
}

// Funzioni aggiuntive (es. "studio_digitale"): si attivano dal CRM sulla
// licenza dello studio. Senza licenza JarAI non ce ne sono. In sviluppo
// JARAI_FUNZIONI="studio_digitale" le attiva senza passare dal proxy.
let funzioniCache: { valore: string[]; scadeIl: number } | null = null;

export async function funzioniAttive(forza = false): Promise<string[]> {
  const daAmbiente = process.env.JARAI_FUNZIONI?.split(',').map((f) => f.trim()).filter(Boolean);
  if (daAmbiente?.length) return daAmbiente;
  if (!forza && funzioniCache && funzioniCache.scadeIl > Date.now()) return funzioniCache.valore;
  const stato = await statoLicenza();
  // Se il servizio non risponde si tiene l'ultimo valore noto: una rete
  // lenta non deve far sparire la sezione a metà lavoro.
  if (!stato.valida && stato.messaggio?.includes('raggiungere') && funzioniCache) return funzioniCache.valore;
  const valore = stato.valida ? (stato.funzioni ?? []) : [];
  funzioniCache = { valore, scadeIl: Date.now() + 5 * 60_000 };
  return valore;
}

export async function funzioneAttiva(nome: string): Promise<boolean> {
  return (await funzioniAttive()).includes(nome);
}
