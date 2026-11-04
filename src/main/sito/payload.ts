import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { lexicalATesto, markdownALexical } from './lexical';
import { percorsoImmagine, tipoImmagine, type Copertina } from './immagini';

// Collegamento al sito dello studio costruito con Payload CMS (Studio
// digitale). L'avvocato inserisce indirizzo del sito, email e password del
// suo utente del pannello; JarAI fa login con l'API REST di Payload
// (POST /api/users/login) e usa il token per leggere e scrivere gli
// articoli. Funziona su qualunque sito nato dal template web di Payload,
// senza codice in più lato sito: collezione "posts" con bozze attive,
// "categories", campi SEO meta.title / meta.description.
//
// Le credenziali sono cifrate con safeStorage come la chiave dello studio
// (claudeAuth.ts). Nessuna scrittura sul sito parte da Claude: gli strumenti
// dell'assistente sono in sola lettura (src/main/sito/strumenti.ts), invio
// della bozza e pubblicazione sono clic dell'avvocato.

const CREDENZIALI_PATH = () => join(app.getPath('userData'), 'sito-credenziali.enc');
const STATO_PATH = () => join(app.getPath('userData'), 'sito.json');

// Percorso pubblico degli articoli nel template Payload (/posts/<slug>).
const PERCORSO_ARTICOLI = '/posts/';
const TIMEOUT_MS = 20_000;

interface Credenziali {
  url: string;
  email: string;
  password: string;
}

interface StatoSalvato {
  url: string;
  email: string;
  collegatoIl: string;
}

export interface StatoSito {
  collegato: boolean;
  url?: string;
  email?: string;
  collegatoIl?: string;
}

export interface ArticoloSito {
  id: number | string;
  titolo: string;
  slug: string;
  descrizione: string;
  categorie: string[];
  pubblicatoIl: string | null;
  url: string;
}

export interface CategoriaSito {
  id: number | string;
  titolo: string;
  slug: string;
}

export interface ArticoloDaInviare {
  titolo: string;
  slug: string;
  metaTitolo: string;
  metaDescrizione: string;
  categorie: string[];
  contenuto: string;
}

export interface EsitoInvio {
  id: number | string;
  stato: 'bozza' | 'pubblicato';
  urlModifica: string;
  urlPubblico: string;
  /** Id della copertina nella libreria del sito, se inviata. */
  copertinaMediaId?: number | string;
}

export interface MediaSito {
  id: number | string;
  alt: string;
  nomeFile: string;
  tipo: string;
  urlAnteprima: string;
  urlGrande: string;
}

export class ErroreSito extends Error {}

// ─── Credenziali ────────────────────────────────────────────────────────

async function salvaCredenziali(cred: Credenziali): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new ErroreSito('La cifratura del sistema non è disponibile su questo computer.');
  }
  await fs.writeFile(CREDENZIALI_PATH(), safeStorage.encryptString(JSON.stringify(cred)));
  const stato: StatoSalvato = { url: cred.url, email: cred.email, collegatoIl: new Date().toISOString() };
  await fs.writeFile(STATO_PATH(), JSON.stringify(stato));
}

async function leggiCredenziali(): Promise<Credenziali | null> {
  try {
    const cifrate = await fs.readFile(CREDENZIALI_PATH());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(cifrate)) as Credenziali;
  } catch {
    return null;
  }
}

export async function statoSito(): Promise<StatoSito> {
  const cred = await leggiCredenziali();
  if (!cred) return { collegato: false };
  let collegatoIl: string | undefined;
  try {
    collegatoIl = (JSON.parse(await fs.readFile(STATO_PATH(), 'utf-8')) as StatoSalvato).collegatoIl;
  } catch {
    // Stato mancante: le credenziali bastano.
  }
  return { collegato: true, url: cred.url, email: cred.email, collegatoIl };
}

export async function scollegaSito(): Promise<void> {
  sessione = null;
  cacheArticoli = null;
  await fs.unlink(CREDENZIALI_PATH()).catch(() => undefined);
  await fs.unlink(STATO_PATH()).catch(() => undefined);
}

// "molfino.vercel.app", "https://molfino.vercel.app/admin/" → "https://molfino.vercel.app"
export function normalizzaUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ErroreSito('L\'indirizzo del sito non è valido.');
  }
  // http solo in locale (sviluppo del sito): la password non viaggia mai in chiaro su internet.
  const locale = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !locale) parsed.protocol = 'https:';
  const percorso = parsed.pathname.replace(/\/(admin|api)(\/.*)?$/, '').replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${percorso}`;
}

// ─── Richieste all'API di Payload ───────────────────────────────────────

interface Sessione {
  url: string;
  token: string;
  scadeIl: number;
  utenteId: number | string | null;
}

let sessione: Sessione | null = null;

async function chiamata(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ErroreSito('Il sito non risponde. Controlla l\'indirizzo e la connessione.');
  }
}

async function login(cred: Credenziali): Promise<Sessione> {
  const risposta = await chiamata(`${cred.url}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cred.email, password: cred.password }),
  });
  if (risposta.status === 401 || risposta.status === 400) {
    throw new ErroreSito('Email o password non corretti per il pannello del sito.');
  }
  if (risposta.status === 404 || risposta.status === 405) {
    throw new ErroreSito('A questo indirizzo non risulta un sito Payload. Controlla l\'indirizzo.');
  }
  if (risposta.status === 403 || risposta.status === 423) {
    throw new ErroreSito('L\'utente è bloccato o non ha accesso al pannello del sito.');
  }
  if (!risposta.ok) throw new ErroreSito('Il sito ha rifiutato l\'accesso. Riprova tra poco.');
  const dati = (await risposta.json().catch(() => null)) as { token?: string; exp?: number; user?: { id?: number | string } } | null;
  if (!dati?.token) throw new ErroreSito('A questo indirizzo non risulta un sito Payload. Controlla l\'indirizzo.');
  // exp in secondi; un minuto di margine. Senza exp, un'ora.
  const scadeIl = dati.exp ? dati.exp * 1000 - 60_000 : Date.now() + 3_600_000;
  return { url: cred.url, token: dati.token, scadeIl, utenteId: dati.user?.id ?? null };
}

async function sessioneValida(): Promise<Sessione> {
  if (sessione && sessione.scadeIl > Date.now()) return sessione;
  const cred = await leggiCredenziali();
  if (!cred) throw new ErroreSito('Il sito dello studio non è collegato. Collegalo da Impostazioni.');
  sessione = await login(cred);
  return sessione;
}

function messaggioDaErrori(dati: unknown): string | null {
  const errori = (dati as { errors?: { message?: string; data?: { errors?: { path?: string; message?: string }[] } }[] } | null)?.errors;
  if (!errori?.length) return null;
  const campi = errori.flatMap((e) => e.data?.errors ?? []);
  if (campi.some((c) => c.path === 'slug')) {
    return 'Sul sito esiste già un articolo con questo indirizzo (slug). Cambialo e riprova.';
  }
  if (campi.length) return `Il sito ha rifiutato alcuni campi: ${campi.map((c) => c.path).join(', ')}.`;
  return errori[0].message ?? null;
}

async function api<T>(percorso: string, init: RequestInit = {}, riprova = true): Promise<T> {
  const s = await sessioneValida();
  const risposta = await chiamata(`${s.url}${percorso}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `JWT ${s.token}`,
      ...(init.headers ?? {}),
    },
  });
  // Token scaduto o revocato: un nuovo login e un secondo tentativo.
  if ((risposta.status === 401 || risposta.status === 403) && riprova) {
    sessione = null;
    return api<T>(percorso, init, false);
  }
  const dati = (await risposta.json().catch(() => null)) as unknown;
  if (!risposta.ok) {
    if (risposta.status === 403) throw new ErroreSito('Questo utente non ha i permessi per gestire gli articoli del sito.');
    throw new ErroreSito(messaggioDaErrori(dati) ?? 'Il sito non ha accettato la richiesta. Riprova tra poco.');
  }
  return dati as T;
}

// ─── Collegamento ───────────────────────────────────────────────────────

export async function collegaSito(urlInput: string, email: string, password: string): Promise<StatoSito> {
  const cred: Credenziali = { url: normalizzaUrl(urlInput), email: email.trim(), password };
  const nuova = await login(cred);
  // Il login da solo non basta: serve un sito con la collezione degli articoli.
  const prova = await chiamata(`${cred.url}/api/posts?limit=1&depth=0&draft=true`, {
    headers: { Authorization: `JWT ${nuova.token}` },
  });
  if (prova.status === 404) {
    throw new ErroreSito('Il sito non ha una sezione articoli compatibile (collezione "posts").');
  }
  if (!prova.ok) throw new ErroreSito('Accesso riuscito, ma non riesco a leggere gli articoli del sito.');
  await salvaCredenziali(cred);
  sessione = nuova;
  cacheArticoli = null;
  return statoSito();
}

// ─── Lettura ────────────────────────────────────────────────────────────

interface DocPayload {
  id: number | string;
  title?: string;
  slug?: string;
  publishedAt?: string | null;
  categories?: (number | string | { id: number | string })[];
  meta?: { title?: string; description?: string };
  content?: unknown;
  _status?: 'draft' | 'published';
}

interface ListaPayload<T> {
  docs: T[];
  totalDocs: number;
}

let cacheArticoli: { articoli: ArticoloSito[]; categorie: CategoriaSito[]; scadeIl: number } | null = null;

export async function elencaCategorie(): Promise<CategoriaSito[]> {
  const dati = await api<ListaPayload<{ id: number | string; title?: string; slug?: string }>>('/api/categories?limit=200&depth=0');
  return dati.docs.map((c) => ({ id: c.id, titolo: c.title ?? String(c.id), slug: c.slug ?? String(c.id) }));
}

// Articoli pubblicati, per lo stile e i collegamenti interni. Cache di
// dieci minuti: in una conversazione Claude li consulta più volte.
export async function elencaArticoli(forza = false): Promise<{ articoli: ArticoloSito[]; categorie: CategoriaSito[] }> {
  if (!forza && cacheArticoli && cacheArticoli.scadeIl > Date.now()) return cacheArticoli;
  const s = await sessioneValida();
  const select = ['title', 'slug', 'publishedAt', 'categories', 'meta'].map((c) => `select[${c}]=true`).join('&');
  const [dati, categorie] = await Promise.all([
    api<ListaPayload<DocPayload>>(`/api/posts?limit=300&depth=0&sort=-publishedAt&where[_status][equals]=published&${select}`),
    elencaCategorie(),
  ]);
  const nomeCategoria = new Map(categorie.map((c) => [String(c.id), c.titolo]));
  const articoli = dati.docs.map((d) => ({
    id: d.id,
    titolo: d.title ?? '',
    slug: d.slug ?? '',
    descrizione: d.meta?.description ?? '',
    categorie: (d.categories ?? []).map((c) => nomeCategoria.get(String(typeof c === 'object' ? c.id : c)) ?? '').filter(Boolean),
    pubblicatoIl: d.publishedAt ?? null,
    url: `${s.url}${PERCORSO_ARTICOLI}${d.slug ?? ''}`,
  }));
  cacheArticoli = { articoli, categorie, scadeIl: Date.now() + 10 * 60_000 };
  return cacheArticoli;
}

export async function leggiArticolo(slug: string): Promise<{ titolo: string; testo: string; url: string } | null> {
  const s = await sessioneValida();
  const dati = await api<ListaPayload<DocPayload>>(
    `/api/posts?limit=1&depth=0&where[slug][equals]=${encodeURIComponent(slug)}&where[_status][equals]=published`,
  );
  const doc = dati.docs[0];
  if (!doc) return null;
  return { titolo: doc.title ?? slug, testo: lexicalATesto(doc.content), url: `${s.url}${PERCORSO_ARTICOLI}${doc.slug ?? slug}` };
}

// ─── Libreria immagini del sito ─────────────────────────────────────────

interface DocMedia {
  id: number | string;
  alt?: string | null;
  filename?: string;
  mimeType?: string;
  url?: string;
  sizes?: Record<string, { url?: string | null } | undefined>;
}

// Indirizzi delle immagini restituiti dal sito: solo questi si scaricano
// (l'URL torna dal renderer, che non deve poter far scaricare altro).
const urlMediaNoti = new Set<string>();

function assoluto(s: Sessione, url: string): string {
  return new URL(url, `${s.url}/`).toString();
}

export async function elencaMediaSito(limite: number): Promise<MediaSito[]> {
  const s = await sessioneValida();
  const dati = await api<ListaPayload<DocMedia>>(
    `/api/media?limit=${limite}&depth=0&sort=-createdAt&where[mimeType][contains]=image`,
  );
  return dati.docs
    .filter((m) => m.url)
    .map((m) => {
      const piccola = m.sizes?.small?.url ?? m.sizes?.thumbnail?.url ?? m.url!;
      const grande = m.sizes?.og?.url ?? m.sizes?.large?.url ?? m.url!;
      // Le misure ridotte possono essere in un formato diverso dall'originale.
      const tipo = /\.webp(\?|$)/i.test(grande) ? 'image/webp' : /\.png(\?|$)/i.test(grande) ? 'image/png' : 'image/jpeg';
      const media: MediaSito = {
        id: m.id,
        alt: m.alt ?? '',
        nomeFile: m.filename ?? String(m.id),
        tipo,
        urlAnteprima: assoluto(s, piccola),
        urlGrande: assoluto(s, grande),
      };
      urlMediaNoti.add(media.urlAnteprima);
      urlMediaNoti.add(media.urlGrande);
      return media;
    });
}

export async function scaricaDalSito(url: string): Promise<Buffer> {
  if (!urlMediaNoti.has(url)) throw new ErroreSito('Immagine non riconosciuta.');
  const risposta = await chiamata(url);
  if (!risposta.ok) throw new ErroreSito('Immagine del sito non disponibile.');
  return Buffer.from(await risposta.arrayBuffer());
}

// Carica la copertina nella libreria del sito (collezione "media"), con
// testo alternativo e, per le foto d'archivio, il credito in didascalia.
async function caricaCopertina(copertina: Copertina, titolo: string): Promise<number | string> {
  const byte = await fs.readFile(percorsoImmagine(copertina.file));
  const estensione = copertina.file.slice(copertina.file.lastIndexOf('.'));
  const nome = `${slugPulito('', titolo).slice(0, 60)}${estensione}`;
  const dati = {
    alt: copertina.alt.trim() || titolo,
    ...(copertina.credito ? { caption: markdownALexical(copertina.credito) } : {}),
  };
  const form = new FormData();
  form.append('file', new Blob([byte], { type: tipoImmagine(copertina.file) }), nome);
  form.append('_payload', JSON.stringify(dati));
  const risposta = await api<{ doc: DocMedia }>('/api/media?depth=0', { method: 'POST', body: form });
  return risposta.doc.id;
}

// Aggiorna il testo alternativo di un'immagine caricata da JarAI. Quelle
// prese dalla libreria del sito restano come le ha lasciate lo studio.
async function aggiornaAlt(copertina: Copertina, titolo: string): Promise<void> {
  if (copertina.origine === 'sito' || copertina.mediaId === undefined) return;
  await api(`/api/media/${encodeURIComponent(String(copertina.mediaId))}?depth=0`, {
    method: 'PATCH',
    body: JSON.stringify({ alt: copertina.alt.trim() || titolo }),
  }).catch(() => undefined);
}

// ─── Scrittura (solo su clic dell'avvocato, mai da Claude) ──────────────

function slugPulito(slug: string, titolo: string): string {
  const base = (slug || titolo)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 90).replace(/-+$/, '') || 'articolo';
}

// Le categorie arrivano da Claude come nomi o slug: si tengono solo quelle
// che esistono davvero sul sito.
function idCategorie(richieste: string[], categorie: CategoriaSito[]): (number | string)[] {
  const norm = (s: string) => s.trim().toLowerCase();
  return richieste
    .map((r) => categorie.find((c) => norm(c.slug) === norm(r) || norm(c.titolo) === norm(r))?.id)
    .filter((id): id is number | string => id !== undefined);
}

function urls(s: Sessione, id: number | string, slug: string) {
  return { urlModifica: `${s.url}/admin/collections/posts/${id}`, urlPubblico: `${s.url}${PERCORSO_ARTICOLI}${slug}` };
}

// Crea l'articolo come bozza sul sito, o aggiorna la bozza già inviata
// (stesso id). Una bozza non è visibile ai visitatori.
export async function inviaBozza(
  articolo: ArticoloDaInviare,
  idEsistente?: number | string,
  copertina?: Copertina,
): Promise<EsitoInvio> {
  const s = await sessioneValida();
  const categorie = await elencaCategorie();
  const slug = slugPulito(articolo.slug, articolo.titolo);
  // La copertina va nella libreria del sito una volta sola: agli invii
  // successivi si riusa lo stesso elemento (e se ne aggiorna il testo alternativo).
  let mediaId = copertina?.mediaId;
  if (copertina && mediaId === undefined) mediaId = await caricaCopertina(copertina, articolo.titolo);
  else if (copertina) await aggiornaAlt(copertina, articolo.titolo);
  const dati = {
    title: articolo.titolo.trim(),
    slug,
    generateSlug: false,
    content: markdownALexical(articolo.contenuto),
    categories: idCategorie(articolo.categorie, categorie),
    meta: {
      title: articolo.metaTitolo.trim() || articolo.titolo.trim(),
      description: articolo.metaDescrizione.trim(),
      ...(mediaId !== undefined ? { image: mediaId } : {}),
    },
    // Senza copertina in JarAI non si tocca quella eventualmente messa dal pannello del sito.
    ...(mediaId !== undefined ? { heroImage: mediaId } : {}),
    ...(s.utenteId != null && idEsistente === undefined ? { authors: [s.utenteId] } : {}),
    _status: 'draft' as const,
  };
  const risposta = idEsistente !== undefined
    ? await api<{ doc: DocPayload }>(`/api/posts/${encodeURIComponent(String(idEsistente))}?draft=true&depth=0`, {
        method: 'PATCH',
        body: JSON.stringify(dati),
      })
    : await api<{ doc: DocPayload }>('/api/posts?draft=true&depth=0', { method: 'POST', body: JSON.stringify(dati) });
  return { id: risposta.doc.id, stato: 'bozza', ...urls(s, risposta.doc.id, risposta.doc.slug ?? slug), copertinaMediaId: mediaId };
}

// Pubblica l'ultima versione della bozza sul sito. Payload parte dall'ultima
// bozza salvata, quindi le eventuali correzioni fatte dall'avvocato nel
// pannello del sito restano: qui si cambia solo lo stato.
export async function pubblicaArticolo(id: number | string): Promise<EsitoInvio> {
  const s = await sessioneValida();
  const risposta = await api<{ doc: DocPayload }>(`/api/posts/${encodeURIComponent(String(id))}?depth=0`, {
    method: 'PATCH',
    body: JSON.stringify({ _status: 'published' }),
  });
  cacheArticoli = null;
  return { id: risposta.doc.id, stato: 'pubblicato', ...urls(s, risposta.doc.id, risposta.doc.slug ?? '') };
}

// Stato attuale sul sito (bozza o pubblicato): l'avvocato può aver
// pubblicato o cancellato l'articolo direttamente dal pannello. Senza
// ?draft=true Payload restituisce il documento principale, che è "published"
// appena esiste una versione pubblicata, anche se dopo ci sono bozze nuove.
export async function statoArticolo(id: number | string): Promise<EsitoInvio | null> {
  const s = await sessioneValida();
  try {
    const doc = await api<DocPayload>(`/api/posts/${encodeURIComponent(String(id))}?depth=0`);
    return { id: doc.id, stato: doc._status === 'published' ? 'pubblicato' : 'bozza', ...urls(s, doc.id, doc.slug ?? '') };
  } catch {
    return null;
  }
}
