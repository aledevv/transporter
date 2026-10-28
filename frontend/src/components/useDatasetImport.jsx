import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { collection, doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { FileSpreadsheet, Loader2, Plus, RefreshCw, Check, X } from 'lucide-react';
import API_BASE_URL from '../config';
import SheetReviewModal from './SheetReviewModal';
import SheetReviewCallout from './SheetReviewCallout';
import { analyzeDatasetRows, diffDataset } from '../utils/sheetIssues';
import { formatCoordinates } from '../utils/coordinates';

const makeStableId = (name, address) =>
    btoa(unescape(encodeURIComponent(`${name}||${address}`))).replace(/[/+=]/g, '_');

const typeOf = name => (/(ic\b|istituto|scuola|liceo|polo|primaria|secondaria)/i.test(name) ? 'istituto' : 'destinazione');

// Summary shown before anything is written: the import adds and updates, never deletes
function ImportSummary({ diff, writing, onWrite, onCancel }) {
    const total = diff.added.length + diff.changed.length;
    return createPortal(
        <div className="sr-backdrop-in fixed inset-0 z-[2100] flex items-center justify-center bg-slate-900/40 p-4">
            <div className="sr-window-in w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="border-b border-slate-100 px-6 py-4">
                    <h3 className="text-[16px] font-semibold text-slate-900">Aggiornare il database fermate?</h3>
                    <p className="mt-0.5 text-sm text-slate-500">Le voci che non sono nel file restano come sono: l'import non cancella niente.</p>
                </div>
                <div className="grid grid-cols-3 gap-3 px-6 py-5">
                    {[
                        ['Nuove', diff.added.length, 'text-emerald-700 bg-emerald-50', Plus],
                        ['Modificate', diff.changed.length, 'text-amber-700 bg-amber-50', RefreshCw],
                        ['Invariate', diff.unchanged, 'text-slate-500 bg-slate-50', Check],
                    ].map(([label, n, cls, Icon]) => (
                        <div key={label} className={`rounded-xl px-4 py-3 ${cls}`}>
                            <div className="flex items-center gap-1.5 text-xs font-semibold"><Icon className="h-3.5 w-3.5" /> {label}</div>
                            <div className="mt-1 text-2xl font-semibold tabular-nums">{n}</div>
                        </div>
                    ))}
                </div>
                {total > 0 && (
                    <div className="max-h-56 overflow-y-auto border-t border-slate-100 px-6 py-3 text-[13px]">
                        {diff.added.map(a => (
                            <div key={`a-${a.name}-${a.address}`} className="flex gap-2 py-1">
                                <span className="font-semibold text-emerald-600">+</span>
                                <span className="truncate"><b className="font-medium">{a.name}</b> · {a.address}</span>
                            </div>
                        ))}
                        {diff.changed.map(c => (
                            <div key={`c-${c.entry.id}`} className="flex gap-2 py-1.5">
                                <span className="font-semibold text-amber-600">~</span>
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{c.next.name}</div>
                                    {c.renamed && (
                                        <div className="truncate text-xs text-slate-500">
                                            <span className="line-through decoration-slate-300">{c.before.address}</span> → <span className="text-slate-800">{c.next.address}</span>
                                        </div>
                                    )}
                                    {c.moved && (
                                        <div className="truncate font-mono text-[11px] text-slate-500">
                                            <span className="line-through decoration-slate-300">{formatCoordinates(c.before.lat, c.before.lon)}</span> → <span className="text-slate-800">{formatCoordinates(c.next.lat, c.next.lon)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-6 py-3">
                    <button onClick={onCancel} disabled={writing} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/70">Annulla</button>
                    <button
                        onClick={onWrite}
                        disabled={writing || total === 0}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                    >
                        {writing && <Loader2 className="h-4 w-4 animate-spin" />}
                        {total === 0 ? 'Niente da aggiornare' : `Scrivi ${total} ${total === 1 ? 'voce' : 'voci'}`}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * Import of the client's stop list (first sheet: name / street / coordinates).
 * Returns the toolbar button, the callout to reopen the review and the windows,
 * so the Database tab can place each one.
 */
export default function useDatasetImport({ db, onImported, onStatus }) {
    const inputRef = useRef(null);
    const [reading, setReading] = useState(false);
    const [sheet, setSheet] = useState(null); // { fileName, columns, rows, saved, open }
    const [diff, setDiff] = useState(null);
    const [writing, setWriting] = useState(false);

    const analysis = useMemo(() => (sheet ? analyzeDatasetRows(sheet.rows, sheet.columns) : null), [sheet?.rows, sheet?.columns]); // eslint-disable-line react-hooks/exhaustive-deps

    const pickFile = async (file) => {
        if (!file) return;
        setReading(true);
        try {
            const form = new FormData();
            form.append('file', file);
            const { data } = await axios.post(`${API_BASE_URL}/api/sheet/read`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
            setSheet({ ...data, saved: null, open: true });
        } catch (err) {
            onStatus?.({ type: 'err', text: err.response?.data?.error || 'Lettura del file non riuscita.' });
        } finally {
            setReading(false);
        }
    };

    const missingColumns = analysis && [!analysis.nameCol && 'Nome', !analysis.addrCol && 'Via', !analysis.coordCol && 'Coordinate'].filter(Boolean);

    const handleConfirm = async ({ userResolutions, edits }) => {
        setSheet(s => ({ ...s, open: false, saved: { resolutions: userResolutions, edits } }));
        // Rows fixed in the side panel replace the Excel values; excluded rows are dropped
        const rows = [];
        sheet.rows.forEach((r, i) => {
            const res = userResolutions[i];
            if (res?.type === 'skip') return;
            if (res?.type === 'edit') rows.push({ name: res.name, address: res.address, lat: res.lat, lon: res.lon });
            else if (analysis.parsed[i]) rows.push(analysis.parsed[i]);
        });
        const snap = await getDocs(collection(db, 'institutes'));
        setDiff(diffDataset(rows, snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    };

    const write = async () => {
        setWriting(true);
        try {
            const items = [
                ...diff.added.map(a => ['set', a]),
                ...diff.changed.map(c => ['update', c]),
            ];
            // Firestore batches take up to 500 writes
            for (let i = 0; i < items.length; i += 450) {
                const batch = writeBatch(db);
                items.slice(i, i + 450).forEach(([kind, it]) => {
                    if (kind === 'set') {
                        batch.set(doc(db, 'institutes', makeStableId(it.name, it.address)), {
                            name: it.name, description: it.address, originalName: it.name, address: it.address,
                            lat: it.lat, lon: it.lon, type: typeOf(it.name), updatedAt: serverTimestamp(),
                        }, { merge: true });
                    } else {
                        batch.update(doc(db, 'institutes', it.entry.id), {
                            description: it.next.address, lat: it.next.lat, lon: it.next.lon, updatedAt: serverTimestamp(),
                        });
                    }
                });
                await batch.commit();
            }
            onStatus?.({ type: 'ok', text: `Database aggiornato: ${diff.added.length} nuove, ${diff.changed.length} modificate.` });
            setDiff(null);
            setSheet(null);
            onImported?.();
        } catch (err) {
            onStatus?.({ type: 'err', text: `Import non riuscito: ${err.message}` });
        } finally {
            setWriting(false);
        }
    };

    const openErrors = analysis
        ? analysis.issues.filter(i => i.severity === 'error' && !sheet.saved?.resolutions?.[i.row]).length + (missingColumns?.length ? 1 : 0)
        : 0;
    const openWarnings = analysis
        ? analysis.issues.filter(i => i.severity === 'warning' && !sheet.saved?.resolutions?.[i.row]).length
        : 0;

    const button = (
        <>
            <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
            <button
                onClick={() => inputRef.current?.click()}
                disabled={!db || reading}
                title="Aggiorna il database da un Excel con nome, via e coordinate"
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
            >
                {reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />}
                Importa Excel
            </button>
        </>
    );

    const callout = sheet && !sheet.open && !diff ? (
        <div className="relative">
            <SheetReviewCallout
                fileName={sheet.fileName}
                rowCount={sheet.rows.length}
                openErrors={openErrors}
                openWarnings={openWarnings}
                processed={false}
                onOpen={() => setSheet(s => ({ ...s, open: true }))}
            />
            <button onClick={() => setSheet(null)} title="Scarta questo file" className="absolute right-[-6px] top-2 rounded-full bg-white p-0.5 text-slate-400 shadow ring-1 ring-black/5 hover:text-slate-600">
                <X className="h-3 w-3" />
            </button>
        </div>
    ) : null;

    const windows = (
        <>
            {sheet?.open && analysis && (
                <SheetReviewModal
                    mode="dataset"
                    title="Aggiorna il database fermate"
                    fileName={sheet.fileName}
                    columns={sheet.columns}
                    rows={sheet.rows}
                    issues={analysis.issues}
                    nameCol={analysis.nameCol}
                    addrCol={analysis.addrCol}
                    coordCol={analysis.coordCol}
                    rowAddress={analysis.rowAddress}
                    missingColumns={missingColumns}
                    savedState={sheet.saved}
                    confirmLabel="Continua"
                    onConfirm={handleConfirm}
                    onClose={saved => setSheet(s => ({ ...s, open: false, saved }))}
                />
            )}
            {diff && (
                <ImportSummary
                    diff={diff}
                    writing={writing}
                    onWrite={write}
                    onCancel={() => setDiff(null)}
                />
            )}
        </>
    );

    return { button, callout, windows };
}
