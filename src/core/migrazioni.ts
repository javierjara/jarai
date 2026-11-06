// Migrazioni dello schema di jarai.db, in ordine. La versione applicata sta
// in PRAGMA user_version: la migrazione N porta il database alla versione N.
// Mai modificare una migrazione già rilasciata: se ne aggiunge una nuova.
//
// Schema: docs/eventstore-protocollo.md §3.1.

export const MIGRAZIONI: readonly string[] = [
  // 1 — schema iniziale
  `
  CREATE TABLE impostazione (
    chiave        TEXT PRIMARY KEY,
    valore        TEXT NOT NULL,              -- JSON
    aggiornata_il TEXT NOT NULL
  );

  CREATE TABLE utente (
    id   TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    ruolo TEXT NOT NULL DEFAULT 'titolare'    -- titolare | associato | praticante | osservatore (spec §7)
  );

  CREATE TABLE dispositivo (
    id              TEXT PRIMARY KEY,
    utente_id       TEXT REFERENCES utente(id),
    nome            TEXT NOT NULL,
    tipo            TEXT NOT NULL,            -- desktop | telefono
    chiave_pubblica TEXT,
    collegato_il    TEXT NOT NULL,
    revocato_il     TEXT
  );

  CREATE TABLE pratica (
    id                TEXT PRIMARY KEY,
    nome              TEXT NOT NULL,
    cliente           TEXT NOT NULL,
    controparte       TEXT,
    ambito            TEXT NOT NULL,
    note              TEXT,
    documenti         INTEGER NOT NULL DEFAULT 0,
    cartella_percorso TEXT,
    aggiornata_il     TEXT NOT NULL,
    eliminata_il      TEXT
  );

  -- Gli id dei documenti sono unici solo dentro la pratica.
  CREATE TABLE documento (
    pratica_id TEXT NOT NULL REFERENCES pratica(id),
    id         TEXT NOT NULL,
    nome       TEXT NOT NULL,
    tipo       TEXT NOT NULL,
    pagine     INTEGER,
    data       TEXT NOT NULL,
    cartella   TEXT NOT NULL,
    dimensione INTEGER,
    percorso   TEXT,
    PRIMARY KEY (pratica_id, id)
  );

  -- Dati fissi della conversazione. Messaggi, stato, titolo e piano stanno
  -- negli eventi: questa tabella serve a elencare e a riprendere la sessione.
  CREATE TABLE conversazione (
    id             TEXT PRIMARY KEY,
    modalita       TEXT NOT NULL,             -- pratica | studio-digitale
    pratica_id     TEXT,
    sdk_session_id TEXT,                      -- resume dell'SDK, persistente
    creata_il      TEXT NOT NULL,
    eliminata_il   TEXT
  );

  -- Studio digitale: dati editoriali della conversazione-articolo (articolo
  -- di lavoro, copertina, stato sul sito, programmazione, social).
  CREATE TABLE conversazione_sito (
    id   TEXT PRIMARY KEY REFERENCES conversazione(id),
    dati TEXT NOT NULL                        -- JSON
  );

  CREATE TABLE idea (
    id   TEXT PRIMARY KEY,
    dati TEXT NOT NULL                        -- JSON
  );

  -- Il log: unica fonte di verità delle conversazioni. Solo INSERT.
  CREATE TABLE evento (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,  -- mai riusato
    conversazione_id TEXT,
    tipo             TEXT NOT NULL,
    payload          TEXT NOT NULL,           -- JSON
    utente_id        TEXT,
    dispositivo_id   TEXT,
    comando_id       TEXT,
    creato_il        TEXT NOT NULL
  );
  CREATE INDEX evento_conversazione ON evento (conversazione_id, seq);

  -- Comandi già eseguiti: lo stesso comandoId rimandato dopo una
  -- riconnessione restituisce gli eventi di allora invece di rifarli.
  CREATE TABLE comando (
    id          TEXT PRIMARY KEY,
    primo_seq   INTEGER,
    ultimo_seq  INTEGER,
    eseguito_il TEXT NOT NULL
  );
  `,
];
