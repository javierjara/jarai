import type { PassoPiano } from '../types';

export default function PlanPanel({ passi }: { passi: PassoPiano[] }) {
  const completati = passi.filter((p) => p.stato === 'completato').length;

  return (
    <div className="plan-panel">
      <div className="plan-panel-header">
        Piano di lavoro
        <span className="plan-panel-count">
          {completati} di {passi.length}
        </span>
      </div>
      <ul className="plan-panel-list">
        {passi.map((p) => (
          <li key={p.id} className={`plan-step plan-step-${p.stato === 'completato' ? 'completed' : 'pending'}`}>
            {p.stato === 'completato' && (
              <span className="plan-step-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            )}
            {p.stato === 'in_corso' && <span className="plan-step-spinner" />}
            {p.stato === 'in_attesa' && <span className="plan-step-dot" />}
            <span>{p.testo}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
