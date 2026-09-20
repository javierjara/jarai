import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// La chiave dello studio (spec §3, modalità "chiave dello studio") viene
// cifrata con safeStorage (Keychain su macOS, DPAPI su Windows) e salvata
// solo nella cartella dati dell'app — mai in chiaro, mai nella cartella
// della pratica.
const CHIAVE_PATH = () => join(app.getPath('userData'), 'claude-key.enc');

// Ultimo esito noto di "Verifica collegamento" (spec §12, Fase 2): permette
// di mostrare "Collegato" subito alla riapertura dell'app senza dover
// rifare una richiesta vera e propria a Claude ogni volta — resta comunque
// solo una cache dell'ultima verifica esplicita, mai un controllo automatico.
const STATO_PATH = () => join(app.getPath('userData'), 'claude-stato.json');

export interface StatoCollegamentoSalvato {
  collegato: boolean;
  modalita?: 'chiave' | 'account';
  messaggio?: string;
  verificatoIl: string;
}

// JarAI usa una cartella di configurazione Claude Code tutta sua (spec §3,
// punto 3): così un eventuale login personale dell'avvocato su questo stesso
// computer resta separato, sia per la chiave sia per il login con l'account
// (src/main/claudeLogin.ts).
export function cartellaConfigurazioneClaude(): string {
  return join(app.getPath('userData'), 'claude-config');
}

export async function salvaChiave(chiave: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('La cifratura del sistema non è disponibile su questo computer.');
  }
  const cifrata = safeStorage.encryptString(chiave);
  await fs.writeFile(CHIAVE_PATH(), cifrata);
}

export async function leggiChiave(): Promise<string | null> {
  try {
    const cifrata = await fs.readFile(CHIAVE_PATH());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(cifrata);
  } catch {
    return null;
  }
}

export async function rimuoviChiave(): Promise<void> {
  try {
    await fs.unlink(CHIAVE_PATH());
  } catch {
    // Nessuna chiave salvata: nulla da rimuovere.
  }
}

export async function haChiave(): Promise<boolean> {
  return (await leggiChiave()) !== null;
}

export async function salvaStatoCollegamento(stato: StatoCollegamentoSalvato): Promise<void> {
  await fs.writeFile(STATO_PATH(), JSON.stringify(stato));
}

export async function leggiStatoCollegamento(): Promise<StatoCollegamentoSalvato | null> {
  try {
    return JSON.parse(await fs.readFile(STATO_PATH(), 'utf-8'));
  } catch {
    return null;
  }
}

export async function rimuoviStatoCollegamento(): Promise<void> {
  try {
    await fs.unlink(STATO_PATH());
  } catch {
    // Nessuno stato salvato: nulla da rimuovere.
  }
}
