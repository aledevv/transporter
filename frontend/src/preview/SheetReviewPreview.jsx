import React, { useEffect, useMemo, useState } from 'react';
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

    const analysis = useMemo(() => {
        if (!data) return null;
        if (mode === 'trip') return analyzeTripRows(data.trip.rows, data.trip.columns, data.institutes);
        return analyzeDatasetRows(data.dataset.rows, data.dataset.columns);
    }, [data, mode]);

    if (!data) return <div className="p-10 text-slate-500">Caricamento anteprima…</div>;
    const sheet = mode === 'trip' ? data.trip : data.dataset;

    return (
        <div className="min-h-screen bg-slate-100 p-8">
            <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
                <span className="text-sm font-semibold text-slate-700">Anteprima finestra di revisione</span>
                {[['trip', 'Excel viaggio (G1)'], ['dataset', 'Excel dataset']].map(([k, l]) => (
                    <button key={k} onClick={() => { setMode(k); setOpen(true); setResult(null); }}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${mode === k ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                        {l}
                    </button>
                ))}
                {!open && <button onClick={() => setOpen(true)} className="ml-auto text-sm font-medium text-blue-600">Riapri</button>}
            </div>
            {result && (
                <pre className="mx-auto mt-4 max-w-3xl overflow-auto rounded-xl bg-white p-4 text-xs text-slate-600 shadow-sm">
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
                    issues={analysis.issues}
                    initialResolutions={analysis.resolutions}
                    candidatesByRow={analysis.candidatesByRow}
                    institutes={data.institutes}
                    nameCol={analysis.nameCol}
                    addrCol={analysis.addrCol}
                    coordCol={analysis.coordCol}
                    onClose={() => setOpen(false)}
                    onConfirm={res => { setResult(res); setOpen(false); }}
                />
            )}
        </div>
    );
}
