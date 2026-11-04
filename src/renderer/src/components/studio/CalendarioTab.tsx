import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConversazioneSito, Idea, PreferenzeSito } from '../../types';
import type { StudioDigitaleApi } from './useStudioDigitale';
import { daGiorno, giornoDi, inizioSettimana, oraBreve } from './util';

interface ArticoloPubblicato {
  id: number | string;
  titolo: string;
  pubblicatoIl: string | null;
  url: string;
}

interface Props {
  conversazioni: ConversazioneSito[];
  idee: Idea[];
  setIdee: Dispatch<SetStateAction<Idea[]>>;
  articoliSito: ArticoloPubblicato[];
  preferenze: PreferenzeSito;
  setPreferenze: Dispatch<SetStateAction<PreferenzeSito>>;
  api: StudioDigitaleApi;
  onApriArticolo: (id: string) => void;
  onApriIdee: () => void;
}

type TipoEvento = 'pub' | 'sch' | 'dra' | 'ide' | 'soc';
type Trascina = { tipo: 'idea' | 'bozza' | 'programmato' | 'linkedin' | 'instagram'; id: string };

interface Evento {
  chiave: string;
  giorno: string;
  ora?: string;
  tipo: TipoEvento;
  testo: string;
  apri: () => void;
  trascina?: Trascina;
  nota?: { testo: string; classe: string };
}

const GIORNI = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

export default function CalendarioTab(p: Props) {
  const [vista, setVista] = useState<'mese' | 'settimana'>('mese');
  const [riferimento, setRiferimento] = useState(() => new Date());
  const [sopra, setSopra] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const oggi = giornoDi(new Date());

  const eventi = useMemo<Evento[]>(() => {
    const out: Evento[] = [];
    const idPubblicati = new Set(p.articoliSito.map((a) => String(a.id)));
    for (const a of p.articoliSito) {
      if (!a.pubblicatoIl) continue;
      const conv = p.conversazioni.find((c) => c.sito && String(c.sito.id) === String(a.id));
      out.push({
        chiave: `pub-${a.id}`,
        giorno: giornoDi(a.pubblicatoIl),
        tipo: 'pub',
        testo: a.titolo,
        apri: () => (conv ? p.onApriArticolo(conv.id) : window.open(a.url, '_blank')),
      });
    }
    for (const c of p.conversazioni) {
      const titolo = c.articolo?.titolo ?? c.titolo;
      if (c.sito?.stato === 'pubblicato' && !idPubblicati.has(String(c.sito.id))) {
        out.push({ chiave: `pubc-${c.id}`, giorno: giornoDi(c.sito.aggiornatoIl), tipo: 'pub', testo: titolo, apri: () => p.onApriArticolo(c.id) });
      } else if (c.programmataPer) {
        out.push({
          chiave: `sch-${c.id}`,
          giorno: giornoDi(c.programmataPer),
          ora: oraBreve(c.programmataPer),
          tipo: 'sch',
          testo: titolo,
          apri: () => p.onApriArticolo(c.id),
          trascina: { tipo: 'programmato', id: c.id },
          nota: c.ultimoErroreProgrammazione
            ? { testo: 'non riuscito', classe: 'red' }
            : { testo: 'approvato', classe: 'green' },
        });
      } else if (c.dataPrevista && c.sito?.stato !== 'pubblicato') {
        out.push({
          chiave: `dra-${c.id}`,
          giorno: c.dataPrevista,
          tipo: 'dra',
          testo: titolo,
          apri: () => p.onApriArticolo(c.id),
          trascina: { tipo: 'bozza', id: c.id },
          nota: { testo: 'da approvare', classe: 'amber' },
        });
      }
      const s = c.social;
      if (s?.linkedinIl) {
        out.push({
          chiave: `li-${c.id}`,
          giorno: giornoDi(s.linkedinIl),
          ora: oraBreve(s.linkedinIl),
          tipo: 'soc',
          testo: `Post LinkedIn · ${titolo}`,
          apri: () => p.onApriArticolo(c.id),
          trascina: { tipo: 'linkedin', id: c.id },
          nota: s.linkedinFatto ? { testo: 'fatto', classe: 'green' } : { testo: 'da fare', classe: 'amber' },
        });
      }
      if (s?.instagramIl) {
        out.push({
          chiave: `ig-${c.id}`,
          giorno: giornoDi(s.instagramIl),
          ora: oraBreve(s.instagramIl),
          tipo: 'soc',
          testo: `Carosello Instagram · ${titolo}`,
          apri: () => p.onApriArticolo(c.id),
          trascina: { tipo: 'instagram', id: c.id },
          nota: s.instagramFatto ? { testo: 'fatto', classe: 'green' } : { testo: 'da fare', classe: 'amber' },
        });
      }
    }
    for (const i of p.idee) {
      if (i.stato !== 'pianificata' || !i.pianificataPer) continue;
      out.push({ chiave: `ide-${i.id}`, giorno: i.pianificataPer, tipo: 'ide', testo: i.titolo, apri: p.onApriIdee, trascina: { tipo: 'idea', id: i.id } });
    }
    return out.sort((a, b) => (a.ora ?? '00:00').localeCompare(b.ora ?? '00:00'));
  }, [p.articoliSito, p.conversazioni, p.idee, p.onApriArticolo, p.onApriIdee]);

  const perGiorno = useMemo(() => {
    const m = new Map<string, Evento[]>();
    for (const e of eventi) m.set(e.giorno, [...(m.get(e.giorno) ?? []), e]);
    return m;
  }, [eventi]);

  // Sposta un elemento trascinato su un altro giorno, mantenendo l'ora.
  async function sposta(t: Trascina, giorno: string) {
    setErrore(null);
    const conOra = (iso: string) => {
      const vecchia = new Date(iso);
      const d = daGiorno(giorno);
      d.setHours(vecchia.getHours(), vecchia.getMinutes(), 0, 0);
      return d.toISOString();
    };
    if (t.tipo === 'idea') {
      p.setIdee((prev) => prev.map((i) => (i.id === t.id ? { ...i, stato: 'pianificata', pianificataPer: giorno } : i)));
      return;
    }
    const c = p.conversazioni.find((x) => x.id === t.id);
    if (!c) return;
    if (t.tipo === 'bozza') p.api.aggiorna(c.id, (x) => ({ ...x, dataPrevista: giorno }));
    if (t.tipo === 'linkedin' && c.social?.linkedinIl) p.api.aggiorna(c.id, (x) => ({ ...x, social: { ...x.social, linkedinIl: conOra(c.social!.linkedinIl!) } }));
    if (t.tipo === 'instagram' && c.social?.instagramIl) p.api.aggiorna(c.id, (x) => ({ ...x, social: { ...x.social, instagramIl: conOra(c.social!.instagramIl!) } }));
    if (t.tipo === 'programmato' && c.programmataPer && c.sito) {
      const quando = conOra(c.programmataPer);
      const esito = await window.jarai.sito.programma({ conversazioneId: c.id, postId: c.sito.id, titolo: c.articolo?.titolo ?? c.titolo, quando });
      if (!esito.ok) setErrore(esito.errore);
      else p.api.aggiorna(c.id, (x) => ({ ...x, programmataPer: quando }));
    }
  }

  function trascinabile(t?: Trascina) {
    return t
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => e.dataTransfer.setData('application/x-jarai', JSON.stringify(t)),
        }
      : {};
  }

  function zonaDrop(giorno: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('application/x-jarai')) return;
        e.preventDefault();
        setSopra(giorno);
      },
      onDragLeave: () => setSopra((s) => (s === giorno ? null : s)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setSopra(null);
        try {
          void sposta(JSON.parse(e.dataTransfer.getData('application/x-jarai')) as Trascina, giorno);
        } catch {
          // Trascinamento non riconosciuto.
        }
      },
    };
  }

  // Giorni da mostrare.
  const giorni: Date[] = [];
  if (vista === 'mese') {
    const primo = new Date(riferimento.getFullYear(), riferimento.getMonth(), 1);
    const inizio = inizioSettimana(primo);
    for (let i = 0; i < 42; i++) giorni.push(new Date(inizio.getFullYear(), inizio.getMonth(), inizio.getDate() + i));
  } else {
    const inizio = inizioSettimana(riferimento);
    for (let i = 0; i < 7; i++) giorni.push(new Date(inizio.getFullYear(), inizio.getMonth(), inizio.getDate() + i));
  }

  function spostaPeriodo(delta: number) {
    setRiferimento((r) =>
      vista === 'mese' ? new Date(r.getFullYear(), r.getMonth() + delta, 1) : new Date(r.getFullYear(), r.getMonth(), r.getDate() + 7 * delta),
    );
  }

  const titoloPeriodo =
    vista === 'mese'
      ? riferimento.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase())
      : `Settimana del ${inizioSettimana(riferimento).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}`;

  // Obiettivo della settimana in corso: articoli pubblicati o programmati.
  const lun = giornoDi(inizioSettimana(new Date()));
  const dom = giornoDi(new Date(inizioSettimana(new Date()).getTime() + 6 * 86_400_000));
  const settimana = eventi.filter((e) => e.giorno >= lun && e.giorno <= dom);
  const fatti = settimana.filter((e) => e.tipo === 'pub' || e.tipo === 'sch').length;
  const mancano = Math.max(0, p.preferenze.obiettivoSettimana - fatti);
  const daValutare = p.idee.filter((i) => i.stato === 'da_valutare');

  return (
    <div className="sd-vista">
      <div className="sd-riga between">
        <div className="sd-riga">
          <button className="btn sm" onClick={() => spostaPeriodo(-1)}>‹</button>
          <span className="sd-sec-t">{titoloPeriodo}</span>
          <button className="btn sm" onClick={() => spostaPeriodo(1)}>›</button>
          <button className="btn ghost sm" onClick={() => setRiferimento(new Date())}>Oggi</button>
        </div>
        <div className="sd-riga">
          <span className="sd-nota-inline">
            Obiettivo:
            <select
              value={p.preferenze.obiettivoSettimana}
              onChange={(e) => p.setPreferenze((x) => ({ ...x, obiettivoSettimana: Number(e.target.value) }))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'articolo' : 'articoli'}
                </option>
              ))}
            </select>
            a settimana · {mancano === 0 ? 'in pari ✓' : `ne ${mancano === 1 ? 'manca 1' : `mancano ${mancano}`}`}
          </span>
          <button className={`btn sm ${vista === 'settimana' ? 'primary' : ''}`} onClick={() => setVista('settimana')}>Settimana</button>
          <button className={`btn sm ${vista === 'mese' ? 'primary' : ''}`} onClick={() => setVista('mese')}>Mese</button>
        </div>
      </div>
      {errore && <div className="sd-errore-largo">{errore}</div>}

      {daValutare.length > 0 && (
        <div className="sd-idee-trascina">
          <span className="muted">Idee da pianificare, trascinale su un giorno:</span>
          {daValutare.slice(0, 6).map((i) => (
            <span key={i.id} className="sd-ev ide" {...trascinabile({ tipo: 'idea', id: i.id })} title={i.motivo}>
              {i.titolo}
            </span>
          ))}
        </div>
      )}

      <div className={`sd-cal ${vista}`}>
        {GIORNI.map((g) => (
          <div key={g} className="dh">{g}</div>
        ))}
        {giorni.map((d) => {
          const g = giornoDi(d);
          const fuori = vista === 'mese' && d.getMonth() !== riferimento.getMonth();
          return (
            <div key={g} className={`d ${fuori ? 'out' : ''} ${g === oggi ? 'today' : ''} ${sopra === g ? 'sopra' : ''}`} {...zonaDrop(g)}>
              <span className="num">{d.getDate()}</span>
              {(perGiorno.get(g) ?? []).map((e) => (
                <button key={e.chiave} className={`sd-ev ${e.tipo}`} title={e.testo} onClick={e.apri} {...trascinabile(e.trascina)}>
                  {e.ora ? `${e.ora} ` : ''}
                  {e.testo}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="sd-legenda-cal">
        <span><i className="pub" />Pubblicato</span>
        <span><i className="sch" />Programmato</span>
        <span><i className="dra" />Bozza con data prevista</span>
        <span><i className="ide" />Idea pianificata</span>
        <span><i className="soc" />LinkedIn / Instagram (promemoria)</span>
      </div>

      <div className="sd-card sd-week">
        <div className="sd-riga between">
          <span className="sd-sec-t piccolo">Questa settimana</span>
          <span className="muted">Trascina un elemento su un altro giorno per spostarlo</span>
        </div>
        <ul>
          {settimana.length === 0 && <li className="muted">Niente in programma.</li>}
          {settimana
            .slice()
            .sort((a, b) => `${a.giorno}${a.ora ?? ''}`.localeCompare(`${b.giorno}${b.ora ?? ''}`))
            .map((e) => {
              const d = daGiorno(e.giorno);
              const passato = e.giorno < oggi || e.tipo === 'pub';
              return (
                <li key={e.chiave}>
                  <span className="when">
                    {d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' })} · {e.tipo === 'pub' ? 'fatto' : (e.ora ?? '—')}
                  </span>
                  <button className="sd-week-t" onClick={e.apri}>
                    {e.tipo === 'pub'
                      ? `Pubblicato «${e.testo}»`
                      : e.tipo === 'sch'
                        ? `Si pubblica da solo «${e.testo}»`
                        : e.tipo === 'ide'
                          ? `Idea da scrivere: «${e.testo}»`
                          : e.tipo === 'dra'
                            ? `Bozza da approvare: «${e.testo}»`
                            : e.testo}
                  </button>
                  {e.nota && !passato && <span className={`sd-chip statico ${e.nota.classe}`}>{e.nota.testo}</span>}
                  {e.tipo === 'soc' && e.trascina && (
                    <label className="sd-fatto">
                      <input
                        type="checkbox"
                        checked={e.nota?.testo === 'fatto'}
                        onChange={(ev) =>
                          p.api.aggiorna(e.trascina!.id, (x) => ({
                            ...x,
                            social: { ...x.social, [e.trascina!.tipo === 'linkedin' ? 'linkedinFatto' : 'instagramFatto']: ev.target.checked },
                          }))
                        }
                      />
                      fatto
                    </label>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}
