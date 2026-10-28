import React from 'react';
import { ArrowRight, ArrowDown, Loader2 } from 'lucide-react';

const TONES = {
    pending: { accent: '#f43f5e', soft: '#ffe4e6', ring: 'ring-rose-100', text: 'text-rose-700', button: 'bg-rose-600 hover:bg-rose-700 text-white' },
    done: { accent: '#10b981', soft: '#d1fae5', ring: 'ring-emerald-100', text: 'text-emerald-700', button: 'bg-emerald-600 hover:bg-emerald-700 text-white' },
    ready: { accent: '#3b82f6', soft: '#dbeafe', ring: 'ring-blue-100', text: 'text-blue-700', button: 'bg-blue-600 hover:bg-blue-700 text-white' },
};

// A small spreadsheet: header row, grid, one highlighted cell carrying the
// state (problem / checked) and a badge in its corner
function SheetIllustration({ tone, state }) {
    const t = TONES[tone];
    return (
        <svg viewBox="0 0 72 60" className="h-14 w-16 flex-shrink-0" aria-hidden="true">
            <rect x="4" y="6" width="56" height="46" rx="7" fill="#fff" stroke="#e2e8f0" strokeWidth="1.5" />
            <path d="M4 13a7 7 0 0 1 7-7h42a7 7 0 0 1 7 7v4H4z" fill="#f1f5f9" />
            <path d="M4 17h56M4 26h56M4 35h56M4 44h56M20 6v46M40 6v46" stroke="#e2e8f0" strokeWidth="1" />
            <rect x="9" y="20" width="7" height="3" rx="1.5" fill="#cbd5e1" />
            <rect x="24" y="20" width="12" height="3" rx="1.5" fill="#cbd5e1" />
            <rect x="9" y="38" width="8" height="3" rx="1.5" fill="#cbd5e1" />
            <rect x="24" y="38" width="10" height="3" rx="1.5" fill="#cbd5e1" />
            <rect x="44" y="20" width="10" height="3" rx="1.5" fill="#cbd5e1" />
            <rect x="44" y="38" width="8" height="3" rx="1.5" fill="#cbd5e1" />
            <g className={state === 'pending' ? 'sr-cell-pulse' : undefined}>
                <rect x="20.5" y="26.5" width="19" height="8" rx="1" fill={t.soft} stroke={t.accent} strokeWidth="1.5" />
            </g>
            <circle cx="58" cy="14" r="9" fill={t.accent} stroke="#fff" strokeWidth="2.5" />
            {state === 'pending' && <path d="M58 9.5v5.5M58 18.2v.3" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />}
            {state === 'done' && <path d="M54 14.2l2.7 2.7 5.3-5.6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
            {state === 'ready' && <path d="M54.5 14h7M58.5 10.5 62 14l-3.5 3.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
    );
}

function Card({ tone, state, title, subtitle, meta, children }) {
    const t = TONES[tone];
    return (
        <div className={`sr-rise-in mt-4 flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-4 ${t.ring}`}>
            <SheetIllustration tone={tone} state={state} />
            <div className="min-w-0 flex-1">
                <div className={`text-[15px] font-semibold ${t.text}`}>{title}</div>
                <div className="mt-0.5 text-sm text-slate-600">{subtitle}</div>
                {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">{meta}</div>}
            </div>
            <div className="flex flex-shrink-0 flex-col items-end gap-1.5">{children}</div>
        </div>
    );
}

function NextButton({ tone, onClick }) {
    return (
        <button onClick={onClick} className={`group inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-all ${TONES[tone].button}`}>
            Vai alla configurazione
            <ArrowDown className="h-4 w-4 transition-transform group-hover:translate-y-0.5" />
        </button>
    );
}

const stopsLine = (stops, passengers) =>
    `${stops} ${stops === 1 ? 'fermata pronta' : 'fermate pronte'}${passengers ? ` · ${passengers} passeggeri` : ''}`;

// Card under the upload area: reopens the review window once it's closed,
// and once the stops are processed points to the next step
export default function SheetReviewCallout({ fileName, rowCount, openErrors, openWarnings, processed, processing, stops, passengers, onOpen, onNext }) {
    const meta = (
        <>
            <span className="max-w-[340px] truncate">{fileName}</span>
            <span>·</span>
            <span>{rowCount} righe</span>
            {openWarnings > 0 && <><span>·</span><span className="font-medium text-amber-600">{openWarnings} da verificare</span></>}
        </>
    );

    if (processing) {
        return (
            <Card tone="ready" state="ready" title="Preparazione delle fermate…" subtitle="Un attimo: assegno le coordinate del database." meta={meta}>
                <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            </Card>
        );
    }
    if (openErrors > 0) {
        return (
            <Card tone="pending" state="pending" title={`${openErrors} ${openErrors === 1 ? 'fermata da rivedere' : 'fermate da rivedere'}`}
                subtitle="Abbina le fermate segnate per continuare con il piano." meta={meta}>
                <button onClick={onOpen} className={`group inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-all ${TONES.pending.button}`}>
                    Apri revisione
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
            </Card>
        );
    }
    if (processed && stops) {
        return (
            <Card tone="done" state="done" title={stopsLine(stops, passengers)} subtitle="Ora scegli destinazione e orari." meta={meta}>
                {onNext && <NextButton tone="done" onClick={onNext} />}
                <button onClick={onOpen} className="text-xs font-medium text-slate-500 hover:text-slate-700">Riapri revisione</button>
            </Card>
        );
    }
    return (
        <Card tone="ready" state="ready" title="Revisione pronta" subtitle="Controlla le fermate prima di continuare." meta={meta}>
            <button onClick={onOpen} className={`group inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-all ${TONES.ready.button}`}>
                Apri revisione
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </button>
        </Card>
    );
}

// Same card for stops that didn't come from an Excel review (database list, restored trip)
export function ReadyCard({ stops, passengers, text, onNext }) {
    return (
        <Card tone="done" state="done" title={stopsLine(stops, passengers)} subtitle={text}>
            {onNext && <NextButton tone="done" onClick={onNext} />}
        </Card>
    );
}
