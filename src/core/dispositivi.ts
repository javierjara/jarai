import type { Database } from './db';

// I telefoni collegati a questo computer (tabella dispositivo). La chiave
// pubblica serve a ricavare le chiavi di sessione; un dispositivo revocato
// non si ricollega più (il relay lo chiude e il ponte lo ignora).

export interface Dispositivo {
  id: string;
  nome: string;
  tipo: 'telefono' | 'desktop';
  chiavePubblica: string | null;
  collegatoIl: string;
  revocatoIl: string | null;
}

interface Riga {
  id: string;
  nome: string;
  tipo: Dispositivo['tipo'];
  chiave_pubblica: string | null;
  collegato_il: string;
  revocato_il: string | null;
}

const daRiga = (r: Riga): Dispositivo => ({
  id: r.id,
  nome: r.nome,
  tipo: r.tipo,
  chiavePubblica: r.chiave_pubblica,
  collegatoIl: r.collegato_il,
  revocatoIl: r.revocato_il,
});

export function elencaDispositivi(db: Database): Dispositivo[] {
  return (db.prepare('SELECT * FROM dispositivo WHERE tipo = ? ORDER BY collegato_il DESC').all('telefono') as unknown as Riga[]).map(daRiga);
}

/** Solo se attivo (non revocato). */
export function dispositivoAttivo(db: Database, id: string): Dispositivo | null {
  const r = db.prepare('SELECT * FROM dispositivo WHERE id = ? AND revocato_il IS NULL').get(id) as unknown as Riga | undefined;
  return r ? daRiga(r) : null;
}

export function aggiungiTelefono(db: Database, d: { id: string; nome: string; chiavePubblica: string; quando: string }): void {
  db.prepare(
    "INSERT INTO dispositivo (id, nome, tipo, chiave_pubblica, collegato_il) VALUES (?, ?, 'telefono', ?, ?)",
  ).run(d.id, d.nome.slice(0, 80), d.chiavePubblica, d.quando);
}

export function revocaDispositivo(db: Database, id: string, quando: string): boolean {
  return Number(db.prepare('UPDATE dispositivo SET revocato_il = ? WHERE id = ? AND revocato_il IS NULL').run(quando, id).changes) > 0;
}
