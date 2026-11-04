import { useEffect, useMemo, useRef, useState } from 'react';
import type { Idea } from '../../types';
import { giornoDi, numero, percorsoDi } from './util';

type Statistiche = Extract<Awaited<ReturnType<typeof window.jarai.sito.statistiche>>, { ok: true }>['dati'];

interface ArticoloPubblicato {
  id: number | string;
  titolo: string;
  slug: string;
  pubblicatoIl: string | null;
  url: string;
}

interface Props {
  articoliSito: ArticoloPubblicato[];
  onNuovaIdea: (idea: Omit<Idea, 'id' | 'stato' | 'creataIl'>) => void;
}

const PERIODI = [
  { giorni: 7, etichetta: '7 g' },
  { giorni: 28, etichetta: '28 g' },
  { giorni: 90, etichetta: '3 mesi' },
  { giorni: 365, etichetta: '12 mesi' },
];

function variazione(ora: number, prima: number, invertita = false) {
  if (!prima) return null;
  const pct = ((ora - prima) / prima) * 100;
  const buona = invertita ? pct < 0 : pct > 0;
  return { testo: `${pct > 0 ? '▲' : pct < 0 ? '▼' : '='} ${numero(Math.abs(pct))}%`, classe: Math.abs(pct) < 0.5 ? '' : buona ? 'up' : 'down' };
}

export default function StatisticheTab({ articoliSito, onNuovaIdea }: Props) {
  const [giorni, setGiorni] = useState(28);
  const [dati, setDati] = useState<Statistiche | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [carico, setCarico] = useState(false);
  const [aggiunte, setAggiunte] = useState<Set<string>>(new Set());

  async function carica(forza = false) {
    setCarico(true);
    setErrore(null);
    const esito = await window.jarai.sito.statistiche(giorni, forza);
    setCarico(false);
    if (!esito.ok) setErrore(esito.errore);
    else setDati(esito.dati);
  }

  useEffect(() => {
    void carica();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giorni]);

  const g = dati?.google ?? null;
  const v = dati?.visite ?? null;

  // Articoli con visite (botcom analytics) e dati Google, uniti per percorso (/posts/slug).
  const righe = useMemo(() => {
    const visite = new Map((v?.perPagina ?? []).map((p) => [percorsoDi(p.percorso), p]));
    const google = new Map((g?.pagine ?? []).map((p) => [percorsoDi(p.url), p]));
    const inizioPeriodo = Date.now() - giorni * 86_400_000;
    return articoliSito
      .map((a) => {
        const percorso = percorsoDi(a.url);
        const vv = visite.get(percorso);
        const gg = google.get(percorso);
        const nuovo = a.pubblicatoIl ? Date.parse(a.pubblicatoIl) >= inizioPeriodo : false;
        let tendenza: { testo: string; classe: string } | null = null;
        if (nuovo) tendenza = { testo: '▲ nuovo', classe: 'up' };
        else if (vv) tendenza = variazione(vv.visite, vv.precedenti);
        return { a, visite: vv?.visite ?? 0, clic: gg?.clic ?? 0, posizione: gg?.posizione ?? null, tendenza };
      })
      .filter((r) => r.visite || r.clic)
      .sort((x, y) => y.visite - x.visite || y.clic - x.clic)
      .slice(0, 10);
  }, [articoliSito, v, g, giorni]);

  // Ricerche in cui il sito compare ma non in prima pagina.
  const opportunita = useMemo(() => {
    if (!g) return [];
    const perRicerca = new Map<string, (typeof g.ricerche)[number]>();
    for (const r of g.ricerche) {
      const prima = perRicerca.get(r.ricerca);
      if (!prima || r.impressioni > prima.impressioni) perRicerca.set(r.ricerca, r);
    }
    const soglia = Math.max(10, Math.round(giorni / 2));
    return [...perRicerca.values()]
      .filter((r) => r.posizione > 7 && r.impressioni >= soglia)
      .sort((a, b) => b.impressioni - a.impressioni)
      .slice(0, 6)
      .map((r) => {
        const percorso = percorsoDi(r.url);
        const articolo = articoliSito.find((a) => percorsoDi(a.url) === percorso);
        return { ...r, articolo };
      });
  }, [g, giorni, articoliSito]);

  const serie = useMemo(() => {
    if (v?.giorni.length) return { etichetta: 'Visite al giorno', unita: 'visite', punti: v.giorni.map((x) => ({ data: x.data, valore: x.visite })) };
    if (g?.giorni.length) return { etichetta: 'Clic da Google al giorno', unita: 'clic', punti: g.giorni.map((x) => ({ data: x.data, valore: x.clic })) };
    return null;
  }, [v, g]);

  const pubblicazioni = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of articoliSito) if (a.pubblicatoIl) m.set(giornoDi(a.pubblicatoIl), a.titolo);
    return m;
  }, [articoliSito]);

  const titoloPeriodo = giorni === 7 ? 'Ultimi 7 giorni' : giorni === 28 ? 'Ultimi 28 giorni' : giorni === 90 ? 'Ultimi 3 mesi' : 'Ultimi 12 mesi';

  return (
    <div className="sd-vista">
      <div className="sd-riga between">
        <span className="sd-sec-t">{titoloPeriodo}</span>
        <div className="sd-riga">
          {PERIODI.map((p) => (
            <button key={p.giorni} className={`btn sm ${giorni === p.giorni ? 'primary' : ''}`} onClick={() => setGiorni(p.giorni)}>
              {p.etichetta}
            </button>
          ))}
          <button className="btn ghost sm" onClick={() => void carica(true)} disabled={carico}>
            {carico ? 'Aggiorno…' : 'Aggiorna'}
          </button>
        </div>
      </div>
      {errore && <div className="sd-errore-largo">{errore}</div>}

      <div className="sd-kpis">
        <Kpi
          etichetta="Visite al sito"
          valore={v ? numero(v.totale) : null}
          delta={v ? variazione(v.totale, v.precedente) : null}
          fonte="botcom analytics"
          mancante={dati && !v ? (dati.erroreVisite ?? 'Non disponibile') : null}
        />
        <Kpi etichetta="Clic da Google" valore={g ? numero(g.totali.clic) : null} delta={g ? variazione(g.totali.clic, g.precedenti.clic) : null} fonte="Search Console" mancante={dati && !g ? 'Non disponibile' : null} />
        <Kpi
          etichetta="Volte in Google"
          valore={g ? numero(g.totali.impressioni) : null}
          delta={g ? variazione(g.totali.impressioni, g.precedenti.impressioni) : null}
          fonte="Search Console"
          mancante={dati && !g ? 'Non disponibile' : null}
        />
        <Kpi
          etichetta="Posizione media"
          valore={g ? numero(g.totali.posizione, 1) : null}
          delta={
            g && g.precedenti.posizione
              ? {
                  testo: `${g.totali.posizione <= g.precedenti.posizione ? '▲' : '▼'} da ${numero(g.precedenti.posizione, 1)}`,
                  classe: g.totali.posizione <= g.precedenti.posizione ? 'up' : 'down',
                }
              : null
          }
          fonte="Search Console"
          mancante={dati && !g ? 'Non disponibile' : null}
        />
      </div>

      {dati?.erroreGoogle && <ConfigGoogle errore={dati.erroreGoogle} />}

      {serie && (
        <div className="sd-card sd-chart-card">
          <div className="sd-riga between">
            <span className="sd-chart-t">{serie.etichetta}</span>
            <span className="muted">
              <span className="sd-pallino pubblicato" /> articolo pubblicato
            </span>
          </div>
          <Grafico punti={serie.punti} unita={serie.unita} pubblicazioni={pubblicazioni} />
        </div>
      )}

      {righe.length > 0 && (
        <div className="sd-card sd-tabella">
          <div className="sd-riga between testa">
            <span className="sd-sec-t piccolo">Articoli più letti</span>
            <span className="muted">clic su un titolo per aprirlo</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Articolo</th>
                <th>Visite</th>
                <th>Clic Google</th>
                <th>Posizione</th>
                <th>Tendenza</th>
              </tr>
            </thead>
            <tbody>
              {righe.map((r) => (
                <tr key={String(r.a.id)}>
                  <td className="t">
                    <a href={r.a.url} target="_blank" rel="noreferrer">{r.a.titolo}</a>
                  </td>
                  <td>{v ? numero(r.visite) : '—'}</td>
                  <td>{g ? numero(r.clic) : '—'}</td>
                  <td>{r.posizione !== null ? numero(r.posizione, 1) : '—'}</td>
                  <td className={r.tendenza?.classe ?? ''}>{r.tendenza?.testo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {g && (
        <div className="sd-card sd-opp">
          <div className="sd-riga between">
            <span className="sd-sec-t piccolo">Opportunità da Google</span>
            <span className="muted">ricerche dove compari ma non hai una risposta forte</span>
          </div>
          <ul>
            {opportunita.length === 0 && <li className="muted">Nessuna ricerca con abbastanza dati in questo periodo.</li>}
            {opportunita.map((o) => {
              const aggiunta = aggiunte.has(o.ricerca);
              return (
                <li key={o.ricerca}>
                  <span className="q">
                    <b>{o.ricerca}</b>
                    <br />
                    <span className="muted">
                      {numero(o.impressioni)} volte in Google · posizione {numero(o.posizione)} ·{' '}
                      {o.articolo ? `«${o.articolo.titolo}»` : 'nessun articolo dedicato'}
                    </span>
                  </span>
                  <button
                    className="btn sm"
                    disabled={aggiunta}
                    onClick={() => {
                      onNuovaIdea(
                        o.articolo
                          ? {
                              titolo: `Aggiornare «${o.articolo.titolo}»`,
                              categoria: '',
                              tipo: 'aggiornamento',
                              motivo: `Su Google compare per «${o.ricerca}» (${o.impressioni} volte) ma in posizione ${numero(o.posizione)}: va aggiornato e rinforzato su questa domanda.`,
                            }
                          : {
                              titolo: o.ricerca.replace(/^./, (c) => c.toUpperCase()),
                              categoria: '',
                              tipo: 'google',
                              motivo: `Il sito compare per «${o.ricerca}» con ${o.impressioni} impressioni ma in posizione ${numero(o.posizione)}, senza un articolo dedicato.`,
                            },
                      );
                      setAggiunte((s) => new Set(s).add(o.ricerca));
                    }}
                  >
                    {aggiunta ? 'Aggiunta alle idee ✓' : o.articolo ? 'Aggiorna articolo' : '→ Idea'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="sd-foot">
        Search Console aggiorna i dati con 2-3 giorni di ritardo · visite: strumento senza cookie, nessun banner necessario
      </div>
    </div>
  );
}

function Kpi(p: {
  etichetta: string;
  valore: string | null;
  delta: { testo: string; classe: string } | null;
  fonte: string;
  mancante: string | null;
  onMancante?: () => void;
}) {
  return (
    <div className="sd-card sd-kpi">
      <div className="l">{p.etichetta}</div>
      <div className="v">{p.valore ?? '—'}</div>
      {p.valore !== null ? (
        <div className={`d ${p.delta?.classe ?? ''}`}>{p.delta ? `${p.delta.testo} sul periodo prima` : ' '}</div>
      ) : (
        <div className="d">
          {p.mancante && p.onMancante ? (
            <button className="btn-link" onClick={p.onMancante}>{p.mancante}</button>
          ) : (
            (p.mancante ?? ' ')
          )}
        </div>
      )}
      <div className="src">{p.fonte}</div>
    </div>
  );
}

function ConfigGoogle({ errore }: { errore: { messaggio: string; codice?: string; account?: string } }) {
  const [copiato, setCopiato] = useState(false);
  if (errore.codice === 'senza_accesso' && errore.account) {
    return (
      <div className="sd-config">
        <div>
          <b>Collega Google Search Console.</b> In Search Console apri il sito → Impostazioni → Utenti e autorizzazioni →
          Aggiungi utente, incolla questo indirizzo con autorizzazione «Limitata»:
        </div>
        <div className="sd-riga">
          <code>{errore.account}</code>
          <button
            className="btn sm"
            onClick={() => {
              void navigator.clipboard.writeText(errore.account!);
              setCopiato(true);
            }}
          >
            {copiato ? 'Copiato ✓' : 'Copia'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sd-config">
      <b>Statistiche Google.</b> {errore.messaggio}
    </div>
  );
}

function Grafico({ punti, unita, pubblicazioni }: { punti: { data: string; valore: number }[]; unita: string; pubblicazioni: Map<string, string> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [larghezza, setLarghezza] = useState(640);
  const [sopra, setSopra] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLarghezza(el.clientWidth || 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 180;
  const pl = 34;
  const pr = 10;
  const pt = 10;
  const pb = 22;
  const n = punti.length;
  const massimo = Math.max(1, ...punti.map((p) => p.valore));
  const passo = massimo <= 10 ? 2 : massimo <= 50 ? 10 : massimo <= 200 ? 50 : massimo <= 1000 ? 200 : 1000;
  const top = Math.ceil(massimo / passo) * passo;
  const x = (i: number) => pl + (n <= 1 ? 0 : (i * (larghezza - pl - pr)) / (n - 1));
  const y = (val: number) => pt + (1 - val / top) * (H - pt - pb);
  const linea = punti.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.valore).toFixed(1)}`).join(' ');
  const tacche: number[] = [];
  for (let t = 0; t <= top; t += passo) tacche.push(t);
  const etichette = n > 1 ? [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1] : [0];
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });

  function muovi(e: React.MouseEvent<SVGRectElement>) {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * larghezza;
    setSopra(Math.max(0, Math.min(n - 1, Math.round(((px - pl) / (larghezza - pl - pr)) * (n - 1)))));
  }

  const punto = sopra !== null ? punti[sopra] : null;

  return (
    <div className="sd-chart" ref={ref}>
      <svg viewBox={`0 0 ${larghezza} ${H}`} width="100%" height={H} role="img" aria-label="Andamento nel periodo">
        {tacche.map((t) => (
          <g key={t}>
            <line x1={pl} x2={larghezza - pr} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={pl - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">{t}</text>
          </g>
        ))}
        {etichette.map((i, k) => (
          <text key={k} x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === etichette.length - 1 ? 'end' : 'middle'} fontSize={10} fill="var(--muted)">
            {fmt(punti[i].data)}
          </text>
        ))}
        {n > 1 && <path d={`${linea} L${x(n - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill="oklch(0.42 0.10 250 / .08)" />}
        <path d={linea} fill="none" stroke="var(--inkblue)" strokeWidth={2} strokeLinejoin="round" />
        {punti.map((p, i) =>
          pubblicazioni.has(p.data) ? <circle key={p.data} cx={x(i)} cy={y(p.valore)} r={4.5} fill="var(--sage)" stroke="#fff" strokeWidth={2} /> : null,
        )}
        {punto && sopra !== null && (
          <>
            <line x1={x(sopra)} x2={x(sopra)} y1={pt} y2={H - pb} stroke="var(--muted)" strokeDasharray="3 3" />
            <circle cx={x(sopra)} cy={y(punto.valore)} r={4.5} fill="var(--inkblue)" stroke="#fff" strokeWidth={2} />
          </>
        )}
        <rect x={pl} y={0} width={Math.max(0, larghezza - pl - pr)} height={H} fill="transparent" onMouseMove={muovi} onMouseLeave={() => setSopra(null)} />
      </svg>
      {punto && sopra !== null && (
        <div className="sd-tip" style={{ left: x(sopra), top: y(punto.valore) - 10 }}>
          <b>
            {numero(punto.valore)} {unita}
          </b>{' '}
          · {fmt(punto.data)}
          {pubblicazioni.has(punto.data) && (
            <>
              <br />
              Pubblicato: {pubblicazioni.get(punto.data)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
