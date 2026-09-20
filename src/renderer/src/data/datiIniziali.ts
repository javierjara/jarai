import type { Conversazione, Documento, Pratica } from '../types';

// Dati di partenza reali: nessuna pratica, documento o conversazione finti.
// Fino a quando l'avvocato non compila lo Studio in Impostazioni, la
// sidebar mostra un nome generico.
export const STUDIO_NOME = 'Studio legale';
export const AVVOCATO_NOME = '';

export const PRATICHE: Pratica[] = [];

export const CONVERSAZIONI: Conversazione[] = [];

export const DOCUMENTI: Record<string, Documento[]> = {};
