// Costanti condivise fra pratiche.ts (scanner cartelle) e documentTools.ts
// (lettura per Claude) — in un modulo a parte per evitare un import
// circolare fra i due.

// Etichetta usata quando un file sta nella radice della pratica, non in una
// sottocartella come "Atti" o "Contratti" (spec §5.4).
export const CARTELLA_PRINCIPALE = 'Cartella principale';

export const ESTENSIONI_AUDIO = new Set(['mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac', 'wma']);
export const ESTENSIONI_IMMAGINE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
export const ESTENSIONI_DOCUMENTO = new Set(['pdf', 'docx', 'doc', 'txt', 'rtf', 'eml', 'msg', 'p7m']);

export const ESTENSIONI_LEGGIBILI = new Set([...ESTENSIONI_DOCUMENTO, ...ESTENSIONI_IMMAGINE, ...ESTENSIONI_AUDIO]);
