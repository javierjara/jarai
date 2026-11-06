import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';

// Segreti su disco (chiave API, licenza, credenziali DeJure e del sito),
// cifrati con safeStorage: Keychain su macOS, DPAPI su Windows. Versione
// async di Electron 45; legge anche i file scritti con quella vecchia.
// Sarà l'implementazione desktop dell'interfaccia Segreti di JarAI Server
// (docs/eventstore-protocollo.md §6).

export const MESSAGGIO_CIFRATURA_ASSENTE = 'La cifratura del sistema non è disponibile su questo computer.';

export function cifraturaDisponibile(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable();
}

/** Scrive testo cifrato. Senza cifratura di sistema lancia un errore: mai in chiaro. */
export async function scriviCifrato(percorso: string, testo: string): Promise<void> {
  if (!(await cifraturaDisponibile())) throw new Error(MESSAGGIO_CIFRATURA_ASSENTE);
  await fs.writeFile(percorso, await safeStorage.encryptStringAsync(testo));
}

/** Legge e decifra. null se il file manca, la cifratura non c'è o il contenuto non si decifra. */
export async function leggiCifrato(percorso: string): Promise<string | null> {
  try {
    const cifrato = await fs.readFile(percorso);
    if (!(await cifraturaDisponibile())) return null;
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(cifrato);
    // Chiave del sistema ruotata: si riscrive con quella nuova.
    if (shouldReEncrypt) await scriviCifrato(percorso, result).catch(() => undefined);
    return result;
  } catch {
    return null;
  }
}
