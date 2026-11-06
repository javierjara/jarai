import type { DatiConversazioneSito, Documento, Pratica } from '../shared/protocollo';
import type { ConversazioneSitoCompleta, SnapshotEntita } from '../shared/entita';
import type { ProiezioneConversazione } from '../shared/reducer';

export type { ConversazioneSitoCompleta, SnapshotEntita };
import type { Database } from './db';
import { MIGRAZIONE_RESTO, migrazioneFatta } from './migrazioneJson';

// Pratiche, documenti, impostazioni, idee e dati editoriali degli articoli
// in jarai.db (passo 5). Funzioni sincrone: le chiama l'host dentro le sue
// transazioni, insieme all'evento entita_cambiata.

interface RigaPratica {
  id: string;
  nome: string;
  cliente: string;
  controparte: string | null;
  ambito: Pratica['ambito'];
  note: string | null;
  documenti: number;
  cartella_percorso: string | null;
  aggiornata_il: string;
}

interface RigaDocumento {
  pratica_id: string;
  id: string;
  nome: string;
  tipo: string;
  pagine: number | null;
  data: string;
  cartella: string;
  dimensione: number | null;
  percorso: string | null;
}

const senzaNull = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;

/**
 * Tutto quello che serve alla finestra all'apertura. null se la seconda
 * parte della migrazione non è fatta: il client resta sul vecchio JSON.
 */
export function leggiEntita(
  db: Database,
  conversazione: (id: string) => ProiezioneConversazione | null,
): SnapshotEntita | null {
  if (!migrazioneFatta(db, MIGRAZIONE_RESTO)) return null;

  const pratiche = (db.prepare('SELECT * FROM pratica WHERE eliminata_il IS NULL ORDER BY aggiornata_il DESC').all() as unknown as RigaPratica[]).map(
    (r): Pratica => ({
      id: r.id,
      nome: r.nome,
      cliente: r.cliente,
      ...(r.controparte !== null ? { controparte: r.controparte } : {}),
      ambito: r.ambito,
      ...(r.note !== null ? { note: r.note } : {}),
      documenti: r.documenti,
      aggiornataIl: r.aggiornata_il,
      cartellaPercorso: r.cartella_percorso,
    }),
  );

  const documenti: Record<string, Documento[]> = {};
  for (const r of db.prepare('SELECT * FROM documento ORDER BY rowid').all() as unknown as RigaDocumento[]) {
    const { pratica_id, ...d } = r;
    (documenti[pratica_id] ??= []).push(senzaNull(d) as Documento);
  }

  const impostazione = (chiave: string) => {
    const r = db.prepare('SELECT valore FROM impostazione WHERE chiave = ?').get(chiave) as { valore: string } | undefined;
    return r ? JSON.parse(r.valore) : undefined;
  };

  const ideeSito = (db.prepare('SELECT dati FROM idea ORDER BY rowid').all() as Array<{ dati: string }>).map((r) => JSON.parse(r.dati));

  const studioDigitale = (
    db
      .prepare(
        `SELECT s.id, s.dati FROM conversazione_sito s JOIN conversazione c ON c.id = s.id
         WHERE c.eliminata_il IS NULL ORDER BY s.rowid`,
      )
      .all() as Array<{ id: string; dati: string }>
  ).map((r): ConversazioneSitoCompleta => {
    const p = conversazione(r.id);
    return { ...JSON.parse(r.dati), id: r.id, messaggi: p?.messaggi ?? [], stato: p?.stato ?? 'completata' };
  });

  return {
    pratiche,
    documenti,
    ...(impostazione('studio') ? { studio: impostazione('studio') } : {}),
    ...(impostazione('preferenzeSito') ? { preferenzeSito: impostazione('preferenzeSito') } : {}),
    ideeSito,
    studioDigitale,
  };
}

export function documentiPratica(db: Database, praticaId: string): Documento[] {
  return (db.prepare('SELECT * FROM documento WHERE pratica_id = ? ORDER BY rowid').all(praticaId) as unknown as RigaDocumento[]).map(
    ({ pratica_id: _p, ...d }) => senzaNull(d) as Documento,
  );
}

export function salvaPratica(db: Database, p: Pratica): void {
  db.prepare(
    `INSERT INTO pratica (id, nome, cliente, controparte, ambito, note, documenti, cartella_percorso, aggiornata_il)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, cliente = excluded.cliente, controparte = excluded.controparte,
       ambito = excluded.ambito, note = excluded.note, documenti = excluded.documenti,
       cartella_percorso = excluded.cartella_percorso, aggiornata_il = excluded.aggiornata_il, eliminata_il = NULL`,
  ).run(p.id, p.nome, p.cliente, p.controparte ?? null, p.ambito, p.note ?? null, p.documenti, p.cartellaPercorso, p.aggiornataIl);
}

/** Cancellazione vera (spec §10.2: "rimuove indice, conversazioni e versioni"). */
export function eliminaPratica(db: Database, praticaId: string): void {
  db.prepare('DELETE FROM documento WHERE pratica_id = ?').run(praticaId);
  db.prepare('DELETE FROM pratica WHERE id = ?').run(praticaId);
}

export function salvaDocumenti(db: Database, praticaId: string, documenti: readonly Documento[]): void {
  db.prepare('DELETE FROM documento WHERE pratica_id = ?').run(praticaId);
  const ins = db.prepare(
    `INSERT INTO documento (pratica_id, id, nome, tipo, pagine, data, cartella, dimensione, percorso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of documenti) {
    ins.run(praticaId, d.id, d.nome, d.tipo, d.pagine ?? null, d.data, d.cartella, d.dimensione ?? null, d.percorso ?? null);
  }
}

export function salvaImpostazione(db: Database, chiave: string, valore: unknown, ora: string): void {
  db.prepare(
    `INSERT INTO impostazione (chiave, valore, aggiornata_il) VALUES (?, ?, ?)
     ON CONFLICT (chiave) DO UPDATE SET valore = excluded.valore, aggiornata_il = excluded.aggiornata_il`,
  ).run(chiave, JSON.stringify(valore), ora);
}

export function salvaIdee(db: Database, idee: ReadonlyArray<{ id: string }>): void {
  db.prepare('DELETE FROM idea').run();
  const ins = db.prepare('INSERT INTO idea (id, dati) VALUES (?, ?)');
  for (const i of idee) ins.run(i.id, JSON.stringify(i));
}

/** Dati editoriali di un articolo. La conversazione deve già esistere. */
export function salvaDatiConversazioneSito(db: Database, dati: DatiConversazioneSito): void {
  const { messaggi: _m, stato: _s, ...editoriale } = dati as DatiConversazioneSito & { messaggi?: unknown; stato?: unknown };
  db.prepare(
    `INSERT INTO conversazione_sito (id, dati) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET dati = excluded.dati`,
  ).run(dati.id, JSON.stringify(editoriale));
}

export function eliminaDatiConversazioneSito(db: Database, id: string): void {
  db.prepare('DELETE FROM conversazione_sito WHERE id = ?').run(id);
}
