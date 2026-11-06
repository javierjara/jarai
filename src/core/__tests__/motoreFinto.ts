import type { EventoMotore, Motore, RichiestaMotore } from '../host';

/** Agente finto: il test decide cosa emette e quando finisce. */
export class MotoreFinto implements Motore {
  richieste: RichiestaMotore[] = [];
  fermate: string[] = [];
  private turni = new Map<string, { emetti: (e: EventoMotore) => void; fine: () => void; errore: (e: unknown) => void }>();

  esegui(r: RichiestaMotore, emetti: (e: EventoMotore) => void): Promise<void> {
    this.richieste.push(r);
    return new Promise((fine, errore) => this.turni.set(r.conversazioneId, { emetti, fine: () => fine(), errore }));
  }
  ferma(id: string): void {
    this.fermate.push(id);
  }
  emetti(id: string, ...eventi: EventoMotore[]): void {
    for (const e of eventi) this.turni.get(id)!.emetti(e);
  }
  finisci(id: string): Promise<void> {
    this.turni.get(id)!.fine();
    return attesa();
  }
  esplodi(id: string): Promise<void> {
    this.turni.get(id)!.errore(new Error('processo claude terminato'));
    return attesa();
  }
}

export const attesa = () => new Promise<void>((r) => setTimeout(r, 0));
