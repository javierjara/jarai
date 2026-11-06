import { DatabaseSync } from 'node:sqlite';
import { MIGRAZIONI } from './migrazioni';

// Apertura di jarai.db con node:sqlite (integrato in Node 22+ ed Electron
// 37+): nessun modulo nativo. Stesso codice su desktop e su JarAI Server.

export type Database = DatabaseSync;

export function apriDatabase(percorso: string): Database {
  const db = new DatabaseSync(percorso);
  // WAL: letture concorrenti mentre l'host scrive. busy_timeout: se un
  // altro processo tiene il lock (es. backup), si aspetta invece di fallire.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  applicaMigrazioni(db);
  return db;
}

export function versioneSchema(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export function applicaMigrazioni(db: Database): void {
  const attuale = versioneSchema(db);
  if (attuale > MIGRAZIONI.length) {
    // Database scritto da una versione di JarAI più recente: meglio fermarsi
    // che scrivere con uno schema che non conosciamo.
    throw new Error(`Schema del database (${attuale}) più recente di questa versione di JarAI (${MIGRAZIONI.length}).`);
  }
  for (let v = attuale; v < MIGRAZIONI.length; v++) {
    inTransazione(db, () => {
      db.exec(MIGRAZIONI[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/**
 * Esegue fn in una transazione. Se una transazione è già aperta (chiamata
 * annidata), fn gira dentro quella: tutto o niente resta la regola.
 */
export function inTransazione<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const risultato = fn();
    db.exec('COMMIT');
    return risultato;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
