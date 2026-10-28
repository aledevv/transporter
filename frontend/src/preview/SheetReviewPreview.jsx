import React, { useCallback, useEffect, useState } from 'react';
import SheetReviewModal from '../components/SheetReviewModal';
import { analyzeTripRows, analyzeDatasetRows } from '../utils/sheetIssues';

// Local-only preview of SheetReviewModal (open with ?preview=sheet-review).
// Reads snapshots from /preview-data/*.json, never writes anywhere.
export default function SheetReviewPreview() {
    const [data, setData] = useState(null);
    const [mode, setMode] = useState('trip');
    const [open, setOpen] = useState(true);
    const [result, setResult] = useState(null);

    useEffect(() => {
        Promise.all(['institutes', 'trip', 'dataset'].map(n => fetch(`/preview-data/${n}.json`).then(r => r.json())))
            .then(([institutes, trip, dataset]) => setData({ institutes, trip, dataset }));
    }, []);

    const analyze = useCallback(rows => (
        mode === 'trip'
            ? analyzeTripRows(rows, data.trip.columns, data.institutes)
            : analyzeDatasetRows(rows, data.dataset.columns)
    ), [data, mode]);

    if (!data) return <div className="p-10 text-slate-500">Caricamento anteprima…</div>;
    const sheet = mode === 'trip' ? data.trip : data.dataset;

    return (
        <div className="min-h-screen bg-slate-100 p-8">
            {/* Above the modal backdrop (z-2000) so the switch stays clickable while the window is open */}
            <div className="fixed left-1/2 top-1.5 z-[2100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/95 px-2 py-1 shadow-lg ring-1 ring-slate-200">
                <span className="pl-2 text-xs font-semibold text-slate-500">Anteprima</span>
                {[['trip', 'Excel viaggio (G1)'], ['dataset', 'Excel dataset']].map(([k, l]) => (
                    <button key={k} onClick={() => { setMode(k); setOpen(true); setResult(null); }}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${mode === k ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                        {l}
                    </button>
                ))}
                {!open && <button onClick={() => setOpen(true)} className="px-2 text-xs font-medium text-blue-600">Riapri</button>}
            </div>
            {result && (
                <pre className="mx-auto mt-12 max-w-3xl overflow-auto rounded-xl bg-white p-4 text-xs text-slate-600 shadow-sm">
                    {JSON.stringify(result, null, 1).slice(0, 4000)}
                </pre>
            )}
            {open && (
                <SheetReviewModal
                    key={mode}
                    mode={mode}
                    title={mode === 'trip' ? 'Controlla le fermate del viaggio' : 'Aggiorna il database fermate'}
                    fileName={sheet.fileName}
                    columns={sheet.columns}
                    rows={sheet.rows}
                    analyze={analyze}
                    institutes={data.institutes}
                    onClose={() => setOpen(false)}
                    onConfirm={res => { setResult(res); setOpen(false); }}
                />
            )}
        </div>
    );
}
