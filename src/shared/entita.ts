import type { DatiConversazioneSito, Documento, Pratica, Studio } from './protocollo';
import type { MessaggioProiettato, ProiezioneConversazione } from './reducer';

// Forma dello snapshot delle entità (richiesta snapshot.entita): condivisa
// tra host (src/core/entita.ts) e client, che non deve dipendere dal database.

export interface ConversazioneSitoCompleta extends DatiConversazioneSito {
  messaggi: MessaggioProiettato[];
  stato: ProiezioneConversazione['stato'];
}

export interface SnapshotEntita {
  pratiche: Pratica[];
  documenti: Record<string, Documento[]>;
  studio?: Studio;
  preferenzeSito?: Record<string, unknown>;
  ideeSito: Array<{ id: string; [campo: string]: unknown }>;
  studioDigitale: ConversazioneSitoCompleta[];
}
