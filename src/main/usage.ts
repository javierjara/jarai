import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Consumo reale (spec §5.9 "Consumo"): ogni richiesta riuscita a Claude
// riporta il proprio costo stimato (total_cost_usd) — lo registriamo qui,
// niente di finto o stimato a monte. In attesa di SQLite (Fase 5) è un
// piccolo file JSON, come lo stato dell'app in store.ts.
interface RegistrazioneUso {
  ts: string;
  modello: string;
  costoUsd: number;
}

const USO_PATH = () => join(app.getPath('userData'), 'claude-usage.json');
const MAX_REGISTRAZIONI = 1000;

async function leggiRegistrazioni(): Promise<RegistrazioneUso[]> {
  try {
    const testo = await fs.readFile(USO_PATH(), 'utf-8');
    const dati = JSON.parse(testo);
    return Array.isArray(dati) ? dati : [];
  } catch {
    return [];
  }
}

export async function registraUso(modello: string, costoUsd: number): Promise<void> {
  const registrazioni = await leggiRegistrazioni();
  registrazioni.push({ ts: new Date().toISOString(), modello, costoUsd });
  const troncate = registrazioni.length > MAX_REGISTRAZIONI ? registrazioni.slice(-MAX_REGISTRAZIONI) : registrazioni;
  await fs.writeFile(USO_PATH(), JSON.stringify(troncate, null, 2), 'utf-8');
}

export interface RiepilogoUso {
  totaleUsd: number;
  questoMeseUsd: number;
  numeroRichieste: number;
  ultime: RegistrazioneUso[];
}

export async function leggiUso(): Promise<RiepilogoUso> {
  const registrazioni = await leggiRegistrazioni();
  const ora = new Date();
  const meseCorrente = `${ora.getFullYear()}-${String(ora.getMonth() + 1).padStart(2, '0')}`;
  const totaleUsd = registrazioni.reduce((s, r) => s + r.costoUsd, 0);
  const questoMeseUsd = registrazioni.filter((r) => r.ts.startsWith(meseCorrente)).reduce((s, r) => s + r.costoUsd, 0);
  return {
    totaleUsd,
    questoMeseUsd,
    numeroRichieste: registrazioni.length,
    ultime: [...registrazioni].slice(-10).reverse(),
  };
}
