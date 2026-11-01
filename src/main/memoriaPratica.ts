import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Memoria della pratica (spec §6.2, tabella memoria_pratica di §8.2): quello
// che Claude ha già accertato su una pratica sopravvive alla conversazione.
// Due tipi di voce:
// - fatti: chiave → valore (parti, ruolo, giudice, scadenze…);
// - schede: per ogni documento letto integralmente, una sintesi con le
//   pagine. Una nuova conversazione parte dalle schede invece di rileggere
//   tutta la pratica; la scheda vale finché il file non cambia (impronta).
// Resta sul computer, come l'indice dei testi: non va da nessuna parte.
// File JSON in attesa di SQLite (Fase 5), come store.ts.

const CARTELLA_MEMORIA = () => join(app.getPath('userData'), 'memoria-pratiche');

export const MAX_CARATTERI_SCHEDA = 4000;
export const MAX_CARATTERI_FATTO = 2000;
export const MAX_FATTI = 150;

export interface Fatto {
  valore: string;
  aggiornatoIl: string;
}

export interface Scheda {
  nome: string;
  impronta: string;
  testo: string;
  aggiornataIl: string;
}

export interface Memoria {
  fatti: Record<string, Fatto>;
  // Per percorso del file: il nome da solo non basta (due "Ricorso.pdf" in
  // cartelle diverse).
  schede: Record<string, Scheda>;
}

const fileMemoria = (praticaId: string) =>
  join(CARTELLA_MEMORIA(), `${createHash('sha1').update(praticaId).digest('hex')}.json`);

export async function leggiMemoria(praticaId: string): Promise<Memoria> {
  try {
    const dati = JSON.parse(await fs.readFile(fileMemoria(praticaId), 'utf-8')) as Partial<Memoria>;
    return { fatti: dati.fatti ?? {}, schede: dati.schede ?? {} };
  } catch {
    return { fatti: {}, schede: {} };
  }
}

// Claude chiama gli strumenti in parallelo: le scritture sulla stessa pratica
// vanno in fila, altrimenti l'ultima sovrascrive le altre.
const code = new Map<string, Promise<unknown>>();

export function modificaMemoria(praticaId: string, modifica: (m: Memoria) => void): Promise<Memoria> {
  const precedente = code.get(praticaId) ?? Promise.resolve();
  const lavoro = precedente
    .catch(() => undefined)
    .then(async () => {
      const memoria = await leggiMemoria(praticaId);
      modifica(memoria);
      await fs.mkdir(CARTELLA_MEMORIA(), { recursive: true });
      const file = fileMemoria(praticaId);
      const temporaneo = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporaneo, JSON.stringify(memoria, null, 2), 'utf-8');
      await fs.rename(temporaneo, file);
      return memoria;
    });
  code.set(praticaId, lavoro);
  return lavoro;
}

// Stessa idea della chiave dell'indice (indice.ts): se il file cambia, la
// scheda non vale più e il documento torna da leggere.
export async function improntaFile(percorso: string): Promise<string | null> {
  try {
    const info = await fs.stat(percorso);
    return `${info.size}|${info.mtimeMs}`;
  } catch {
    return null;
  }
}

export async function eliminaMemoria(praticaId: string): Promise<void> {
  await fs.rm(fileMemoria(praticaId), { force: true });
}
