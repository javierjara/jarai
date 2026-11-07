import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EventoMotore } from '../host';
import { MotoreServer, promptConStoria } from '../../server/motore';

function sdkFinto(messaggi: unknown[], visti: Array<{ prompt: string; options: Options }>) {
  return ((args: { prompt: string; options: Options }) => {
    visti.push(args);
    return (async function* () {
      for (const m of messaggi) yield m;
    })();
  }) as never;
}

const richiesta = { conversazioneId: 'c1', modalita: 'pratica' as const, testo: 'E la scadenza?', qualita: 'Standard' as const, praticaId: 'p1', documenti: [] };

describe('motore dell\'assistente di riserva', () => {
  it('senza sessione rimanda la storia; poi riprende la sessione; passa dal proxy con la licenza', async () => {
    const visti: Array<{ prompt: string; options: Options }> = [];
    const eventi: EventoMotore[] = [];
    const motore = new MotoreServer({
      proxy: 'https://proxy',
      licenza: 'jarai_x',
      cartellaSessioni: '/dev/shm/prova',
      fonti: () => ({ documenti: [], testo: async () => null, memoria: null }),
      storia: () => [
        { id: '1', ruolo: 'avvocato', testo: 'Quanto è il corrispettivo?' },
        { id: '2', ruolo: 'assistente', testo: 'Euro 12.400.' },
        { id: '3', ruolo: 'avvocato', testo: 'E la scadenza?' },
      ],
      interroga: sdkFinto(
        [
          { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__jarai-documenti__leggi_documento' } } },
          { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Il 30 ' } } },
          { type: 'result', subtype: 'success', is_error: false, result: 'Il 30 aprile.', session_id: 'sess-1', total_cost_usd: 0.1 },
        ],
        visti,
      ),
    });
    await motore.esegui(richiesta, (e) => eventi.push(e));
    expect(visti[0].prompt).toContain('AVVOCATO: Quanto è il corrispettivo?');
    expect(visti[0].prompt).toContain('ASSISTENTE: Euro 12.400.');
    expect(visti[0].prompt.endsWith('E la scadenza?')).toBe(true);
    expect(visti[0].prompt.match(/E la scadenza\?/g)).toHaveLength(1);
    expect(visti[0].options.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'jarai_x', CLAUDE_CONFIG_DIR: '/dev/shm/prova' });
    expect(visti[0].options.tools).toEqual([]);
    expect(eventi).toEqual([
      { tipo: 'attivita', testo: 'Sto leggendo un documento della pratica…' },
      { tipo: 'delta', testo: 'Il 30 ' },
      { tipo: 'completato', testo: 'Il 30 aprile.', costoUsd: 0.1 },
    ]);

    await motore.esegui({ ...richiesta, testo: 'Grazie' }, () => undefined);
    expect(visti[1].prompt).toBe('Grazie');
    expect(visti[1].options.resume).toBe('sess-1');
  });

  it('errori in italiano, mai il testo grezzo', async () => {
    const eventi: EventoMotore[] = [];
    const motore = new MotoreServer({
      proxy: 'p',
      licenza: 'l',
      cartellaSessioni: '/tmp',
      fonti: () => ({ documenti: [], testo: async () => null, memoria: null }),
      storia: () => [],
      interroga: sdkFinto([{ type: 'result', subtype: 'success', is_error: true, result: 'Licenza JarAI scaduta.', session_id: 's' }], []),
    });
    await motore.esegui(richiesta, (e) => eventi.push(e));
    expect(eventi).toEqual([{ tipo: 'errore', messaggio: 'Licenza JarAI scaduta.', scartaParziale: true }]);
    expect(promptConStoria([], 'ciao')).toBe('ciao');
  });
});
