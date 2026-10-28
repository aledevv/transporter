import React, { useMemo, useState } from 'react';
import {
    X, Database, Plus, Search, Check, AlertTriangle, ExternalLink, Trash2,
    FileSpreadsheet, MapPin, Undo2,
} from 'lucide-react';
import { findCandidates, normalizeForCompare } from '../utils/matchInstitutes';
import { parseCoordinates, formatCoordinates } from '../utils/coordinates';

// Spreadsheet-style review of an uploaded Excel. Problem cells are coloured and
// carry a "cursor chip" (like the name tags of collaborators in a shared doc)
// with the problem in short and the action that fixes it. The action opens a
// side panel with the likeliest dataset entries or a form to add a new one.
//
// mode 'trip'    -> each row must map to a dataset entry (resolution type db/new/skip)
// mode 'dataset' -> each row is a dataset entry; bad cells are fixed in place (type edit/skip)

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const TONE = {
    error: {
        cell: 'bg-rose-50 shadow-[inset_0_0_0_2px_#f43f5e]',
        chip: 'bg-rose-500',
    },
    warning: {
        cell: 'bg-amber-50 shadow-[inset_0_0_0_2px_#f59e0b]',
        chip: 'bg-amber-500',
    },
    resolved: {
        cell: 'bg-emerald-50 shadow-[inset_0_0_0_2px_#10b981]',
        chip: 'bg-emerald-600',
    },
};

// The tag lives inside its cell, under the value: the row grows to fit it, so
// tags of different cells (same row or consecutive rows) never overlap.
function CellTag({ tone, children, active }) {
    return (
        <div
            className={`mt-1 inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md py-[3px] pl-2 pr-1 font-sans text-[11.5px] font-medium leading-snug text-white shadow-sm ${TONE[tone].chip} ${active ? 'ring-2 ring-blue-500 ring-offset-1' : ''}`}
        >
            {children}
        </div>
    );
}

function ChipButton({ onClick, children }) {
    return (
        <button
            onClick={onClick}
            className="inline-flex items-center gap-1 rounded-full bg-white/20 hover:bg-white/35 px-2 py-0.5 text-[11px] font-semibold transition-colors"
        >
            {children}
        </button>
    );
}

function scoreColor(score) {
    if (score >= 0.85) return 'bg-emerald-500';
    if (score >= 0.6) return 'bg-amber-400';
    return 'bg-slate-300';
}

function googleMapsUrl(query) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function CoordinateField({ value, onChange }) {
    const parsed = value.trim() ? parseCoordinates(value) : null;
    return (
        <div>
            <input
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder="46.0697, 11.1211"
                className={`w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none transition-colors ${
                    !parsed ? 'border-slate-200 focus:border-blue-400'
                        : parsed.ok ? 'border-emerald-300 focus:border-emerald-500' : 'border-rose-300 focus:border-rose-500'
                }`}
            />
            <div className="mt-1 min-h-[18px] text-xs">
                {!parsed && <span className="text-slate-400">Incolla le coordinate copiate da Google Maps</span>}
                {parsed && parsed.ok && (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                        <Check className="h-3 w-3" /> {formatCoordinates(parsed.lat, parsed.lon)}
                        {parsed.warning && <span className="text-amber-600"> · {parsed.warning}, corrette</span>}
                    </span>
                )}
                {parsed && !parsed.ok && <span className="text-rose-600">{parsed.error}</span>}
            </div>
        </div>
    );
}

function SidePanel({ mode, row, rowIndex, nameCol, addrCol, coordCol, institutes, initialCandidates, current, onResolve, onClose }) {
    const rowName = String(row[nameCol] ?? '').trim();
    const rowAddr = String(row[addrCol] ?? '').trim();
    const [tab, setTab] = useState(mode === 'dataset' ? 'new' : 'db');
    const [query, setQuery] = useState('');
    const [form, setForm] = useState({
        name: current?.name ?? rowName,
        address: current?.address ?? rowAddr,
        coords: current?.lat != null ? formatCoordinates(current.lat, current.lon)
            : (coordCol ? String(row[coordCol] ?? '') : ''),
    });

    const suggestions = useMemo(() => {
        if (!query.trim()) return initialCandidates || findCandidates({ name: rowName, address: rowAddr }, institutes, { maxCandidates: 8, threshold: 0.3 });
        const q = normalizeForCompare(query);
        return institutes
            .filter(i => normalizeForCompare(`${i.name} ${i.description || ''} ${i.address || ''} ${(i.aliases || []).join(' ')}`).includes(q))
            .slice(0, 20);
    }, [query, institutes, initialCandidates, rowName, rowAddr]);

    const parsed = parseCoordinates(form.coords);
    const canAdd = form.name.trim() && form.address.trim() && parsed.ok;
    const selectedId = current?.type === 'db' ? current.entry?.id : null;

    return (
        <aside className="flex w-[400px] flex-shrink-0 flex-col border-l border-slate-200 bg-white animate-[slideIn_.18s_ease-out]">
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
                <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Riga {rowIndex + 2}</div>
                    <div className="truncate text-[15px] font-semibold text-slate-900">{rowName || '—'}</div>
                    <div className="truncate text-sm text-slate-500">{rowAddr || '—'}</div>
                </div>
                <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                    <X className="h-4 w-4" />
                </button>
            </div>

            {mode === 'trip' && (
                <div className="flex gap-1 border-b border-slate-100 px-5 pt-2">
                    {[['db', 'Dal database', Database], ['new', 'Nuova fermata', Plus]].map(([k, label, Icon]) => (
                        <button
                            key={k}
                            onClick={() => setTab(k)}
                            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                                tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            <Icon className="h-3.5 w-3.5" /> {label}
                        </button>
                    ))}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 py-4">
                {tab === 'db' && (
                    <>
                        <div className="relative mb-3">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Cerca per nome, paese o via…"
                                className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-400"
                            />
                        </div>
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            {query.trim() ? `Risultati (${suggestions.length})` : 'Più probabili'}
                        </div>
                        {suggestions.length === 0 && (
                            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                                Nessuna fermata trovata.
                                <button onClick={() => setTab('new')} className="mt-2 block w-full font-medium text-blue-600 hover:text-blue-700">
                                    Aggiungila come nuova →
                                </button>
                            </div>
                        )}
                        <div className="space-y-2">
                            {suggestions.map(c => {
                                const isSel = selectedId && c.id === selectedId;
                                return (
                                    <button
                                        key={c.id || `${c.name}-${c.lat}`}
                                        onClick={() => onResolve({ type: 'db', entry: c })}
                                        className={`group w-full rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                                            isSel ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/40'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{c.name}</div>
                                            {c._matchScore != null && (
                                                <div className="flex items-center gap-1.5">
                                                    <div className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-100">
                                                        <div className={`h-full ${scoreColor(c._matchScore)}`} style={{ width: `${Math.round(c._matchScore * 100)}%` }} />
                                                    </div>
                                                    <span className="w-8 text-right text-[11px] font-semibold tabular-nums text-slate-500">{Math.round(c._matchScore * 100)}%</span>
                                                </div>
                                            )}
                                        </div>
                                        <div className="mt-0.5 truncate text-[13px] text-slate-600">{c.description || c.address}</div>
                                        <div className="mt-1 flex items-center gap-1 font-mono text-[11px] text-slate-400">
                                            <MapPin className="h-3 w-3" /> {Number(c.lat).toFixed(5)}, {Number(c.lon).toFixed(5)}
                                            {c._matchedAlias && <span className="ml-auto font-sans text-slate-400">alias «{c._matchedAlias}»</span>}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </>
                )}

                {tab === 'new' && (
                    <div className="space-y-4">
                        {mode === 'trip' && (
                            <p className="text-[13px] leading-relaxed text-slate-500">
                                La fermata viene aggiunta al database e usata per questo viaggio. Nome e via arrivano dall'Excel: correggili se serve.
                            </p>
                        )}
                        <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-slate-600">Nome fermata</span>
                            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                        </label>
                        <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-slate-600">Via <span className="font-normal text-slate-400">(come apparirà nei documenti)</span></span>
                            <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                        </label>
                        <div>
                            <div className="mb-1 flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-600">Coordinate</span>
                                <a href={googleMapsUrl(`${form.address} ${form.name}`)} target="_blank" rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
                                    Cerca su Google Maps <ExternalLink className="h-3 w-3" />
                                </a>
                            </div>
                            <CoordinateField value={form.coords} onChange={v => setForm(f => ({ ...f, coords: v }))} />
                        </div>
                        <button
                            disabled={!canAdd}
                            onClick={() => onResolve({ type: mode === 'trip' ? 'new' : 'edit', name: form.name.trim(), address: form.address.trim(), lat: parsed.lat, lon: parsed.lon })}
                            className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                        >
                            {mode === 'trip' ? 'Aggiungi al database e usa' : 'Applica correzione'}
                        </button>
                    </div>
                )}
            </div>

            <div className="border-t border-slate-100 px-5 py-3">
                <button onClick={() => onResolve({ type: 'skip' })}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" /> {mode === 'trip' ? 'Escludi questa fermata dal viaggio' : 'Non importare questa riga'}
                </button>
            </div>
        </aside>
    );
}

function resolutionLabel(res) {
    if (!res) return null;
    if (res.type === 'db') return res.entry.name;
    if (res.type === 'new') return `Nuova: ${res.name}`;
    if (res.type === 'edit') return formatCoordinates(res.lat, res.lon);
    if (res.type === 'skip') return 'Esclusa';
    return null;
}

export default function SheetReviewModal({
    mode = 'trip',
    title,
    fileName,
    columns,
    rows,
    issues,
    initialResolutions = {},
    candidatesByRow = {},
    institutes = [],
    nameCol, addrCol, coordCol,
    onConfirm,
    onClose,
}) {
    // Rows the user resolved by hand (overrides the preselection)
    const [resolutions, setResolutions] = useState({});
    const [openRow, setOpenRow] = useState(null);
    const [onlyProblems, setOnlyProblems] = useState(false);

    const effective = { ...initialResolutions, ...resolutions };
    const issuesByCell = useMemo(() => {
        const m = {};
        issues.forEach(i => { (m[`${i.row}|${i.col}`] ||= []).push(i); });
        return m;
    }, [issues]);
    const rowsWithIssues = useMemo(() => new Set(issues.map(i => i.row)), [issues]);

    // Cell values typed in place (issues with fix: 'number', e.g. missing participants)
    const [edits, setEdits] = useState({});
    const editOk = (i) => {
        const v = edits[`${i.row}|${i.col}`];
        return v !== undefined && v !== '' && !isNaN(Number(v)) && Number(v) > 0;
    };
    const isResolved = (i) => (i.fix === 'number' ? editOk(i) : resolutions[i.row] !== undefined);
    const openErrors = issues.filter(i => i.severity === 'error' && !isResolved(i));
    const openWarnings = issues.filter(i => i.severity === 'warning' && !isResolved(i));
    const okCount = rows.length - new Set([...openErrors, ...openWarnings].map(i => i.row)).size;

    const resolve = (row, res) => {
        setResolutions(r => ({ ...r, [row]: res }));
        setOpenRow(null);
    };
    const undo = (row) => setResolutions(r => { const n = { ...r }; delete n[row]; return n; });

    const visibleRows = rows.map((r, i) => i).filter(i => !onlyProblems || rowsWithIssues.has(i));
    const showMatchCol = mode === 'trip';

    return (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px]">
            <style>{'@keyframes slideIn{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}'}</style>
            <div className="flex h-[90vh] w-full max-w-[1480px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-center gap-4 border-b border-slate-200 px-6 py-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                        <FileSpreadsheet className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-[17px] font-semibold text-slate-900">{title}</h2>
                        <div className="truncate text-sm text-slate-500">{fileName} · primo foglio · {rows.length} righe</div>
                    </div>
                    <div className="hidden items-center gap-2 md:flex">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${openErrors.length ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-400'}`}>
                            <span className="h-2 w-2 rounded-full bg-rose-500" /> {openErrors.length} da risolvere
                        </span>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${openWarnings.length ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`}>
                            <span className="h-2 w-2 rounded-full bg-amber-500" /> {openWarnings.length} da verificare
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" /> {okCount} ok
                        </span>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex min-h-0 flex-1">
                    <div className="min-w-0 flex-1 overflow-auto bg-slate-100/60">
                        <table className="min-w-full border-separate border-spacing-0 bg-white text-[13px] text-slate-800">
                            <thead className="sticky top-0 z-40">
                                <tr>
                                    <th className="sticky left-0 z-10 h-6 w-11 border-b border-r border-slate-200 bg-slate-100" />
                                    {columns.map((c, ci) => (
                                        <th key={c} className="h-6 border-b border-r border-slate-200 bg-slate-100 text-[11px] font-medium text-slate-400">
                                            {COL_LETTERS[ci]}
                                        </th>
                                    ))}
                                    {showMatchCol && <th className="h-6 border-b border-slate-200 bg-blue-50 text-[11px] font-medium text-blue-400">→</th>}
                                </tr>
                                <tr>
                                    <th className="sticky left-0 z-10 border-b-2 border-r border-slate-300 bg-slate-100 text-[11px] font-medium text-slate-400">1</th>
                                    {columns.map(c => (
                                        <th key={c} className="whitespace-nowrap border-b-2 border-r border-slate-300 bg-slate-50 px-3 py-2 text-left font-semibold text-slate-700">{c}</th>
                                    ))}
                                    {showMatchCol && (
                                        <th className="whitespace-nowrap border-b-2 border-slate-300 bg-blue-50 px-3 py-2 text-left font-semibold text-blue-800">Fermata nel database</th>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {visibleRows.map(ri => {
                                    const r = rows[ri];
                                    const res = effective[ri];
                                    const userRes = resolutions[ri];
                                    const skipped = res?.type === 'skip';
                                    const active = openRow === ri;
                                    return (
                                        <tr key={ri} className={`${active ? 'bg-blue-50/70' : ''} ${skipped ? 'opacity-45' : ''}`}>
                                            <td className={`sticky left-0 z-10 border-b border-r border-slate-200 px-2 pt-2.5 align-top text-center text-[11px] tabular-nums ${active ? 'bg-blue-100 text-blue-700 font-semibold' : 'bg-slate-50 text-slate-400'}`}>
                                                {ri + 2}
                                            </td>
                                            {columns.map(c => {
                                                const cellIssues = issuesByCell[`${ri}|${c}`] || [];
                                                const issue = cellIssues.find(i => i.severity === 'error') || cellIssues[0];
                                                const fixInPlace = issue?.fix === 'number';
                                                const cellResolved = issue && (fixInPlace ? editOk(issue) : !!userRes);
                                                const tone = issue ? (cellResolved ? 'resolved' : issue.severity) : null;
                                                let value = r[c];
                                                if (mode === 'dataset' && userRes?.type === 'edit') {
                                                    if (c === nameCol) value = userRes.name;
                                                    if (c === addrCol) value = userRes.address;
                                                    if (c === coordCol) value = formatCoordinates(userRes.lat, userRes.lon);
                                                }
                                                const isCoord = c === coordCol;
                                                return (
                                                    <td
                                                        key={c}
                                                        className={`h-9 max-w-[380px] border-b border-r border-slate-200 px-3 py-1.5 align-top ${tone ? TONE[tone].cell : ''} ${isCoord ? 'font-mono text-[12px]' : ''}`}
                                                    >
                                                        <div className={`truncate ${skipped ? 'line-through' : ''}`}>
                                                            {value === '' || value == null ? <span className="italic text-slate-300">vuoto</span> : String(value)}
                                                        </div>
                                                        {fixInPlace && (
                                                            <div className="flex flex-col items-start">
                                                                <CellTag tone={tone} active={active}>
                                                                    {cellResolved ? <Check className="h-3 w-3 flex-shrink-0" /> : <AlertTriangle className="h-3 w-3 flex-shrink-0" />}
                                                                    <span>{cellResolved ? 'Corretto' : issue.message}</span>
                                                                    <input
                                                                        type="number" min="1" placeholder="n."
                                                                        value={edits[`${ri}|${c}`] ?? ''}
                                                                        onChange={e => setEdits(x => ({ ...x, [`${ri}|${c}`]: e.target.value }))}
                                                                        className="w-14 rounded bg-white px-1.5 py-0.5 text-[11.5px] font-semibold text-slate-800 outline-none"
                                                                    />
                                                                </CellTag>
                                                            </div>
                                                        )}
                                                        {issue && !fixInPlace && !userRes && (
                                                            <div className="flex flex-col items-start">
                                                                <CellTag tone={issue.severity} active={active}>
                                                                    {issue.severity === 'error'
                                                                        ? <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                                                        : <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-white/90" />}
                                                                    <span>{cellIssues.map(i => i.message).join(' · ')}</span>
                                                                    <ChipButton onClick={() => setOpenRow(ri)}>
                                                                        {mode === 'trip' ? <><Database className="h-3 w-3" /> Seleziona da database</> : 'Correggi'}
                                                                    </ChipButton>
                                                                </CellTag>
                                                            </div>
                                                        )}
                                                        {issue && !fixInPlace && userRes && (
                                                            <div className="flex flex-col items-start">
                                                                <CellTag tone="resolved" active={active}>
                                                                    <Check className="h-3 w-3 flex-shrink-0" />
                                                                    <span className="max-w-[220px] truncate">{resolutionLabel(userRes)}</span>
                                                                    <ChipButton onClick={() => setOpenRow(ri)}>Cambia</ChipButton>
                                                                    <button onClick={() => undo(ri)} title="Annulla" className="rounded-full p-0.5 hover:bg-white/30">
                                                                        <Undo2 className="h-3 w-3" />
                                                                    </button>
                                                                </CellTag>
                                                            </div>
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            {showMatchCol && (
                                                <td className="h-9 max-w-[320px] border-b border-slate-200 bg-blue-50/40 px-3 py-1.5 align-top">
                                                    {res && res.type !== 'skip' ? (
                                                        <button onClick={() => setOpenRow(ri)} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-blue-700">
                                                            <span className="truncate text-slate-700">{res.type === 'db' ? res.entry.name : res.name}</span>
                                                            <span className="flex-shrink-0 font-mono text-[11px] text-slate-400">
                                                                {Number(res.type === 'db' ? res.entry.lat : res.lat).toFixed(4)}, {Number(res.type === 'db' ? res.entry.lon : res.lon).toFixed(4)}
                                                            </span>
                                                        </button>
                                                    ) : (
                                                        <span className="text-slate-300">—</span>
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {openRow !== null && (
                        <SidePanel
                            key={openRow}
                            mode={mode}
                            row={rows[openRow]}
                            rowIndex={openRow}
                            nameCol={nameCol}
                            addrCol={addrCol}
                            coordCol={coordCol}
                            institutes={institutes}
                            initialCandidates={candidatesByRow[openRow]}
                            current={effective[openRow]}
                            onResolve={res => resolve(openRow, res)}
                            onClose={() => setOpenRow(null)}
                        />
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center gap-4 border-t border-slate-200 bg-slate-50/70 px-6 py-3.5">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                        <input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                        Mostra solo righe con problemi
                    </label>
                    <div className="flex-1 text-right text-sm text-slate-500">
                        {openErrors.length > 0
                            ? `Risolvi ${openErrors.length === 1 ? 'la cella rossa' : `le ${openErrors.length} celle rosse`} per continuare`
                            : 'Tutto pronto'}
                    </div>
                    <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/70">Annulla</button>
                    <button
                        disabled={openErrors.length > 0}
                        onClick={() => onConfirm?.({ resolutions: effective, edits })}
                        className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                    >
                        {mode === 'trip' ? 'Conferma e continua' : 'Importa nel database'}
                    </button>
                </div>
            </div>
        </div>
    );
}
