import React, { useState } from 'react';
import { CheckCircle, ChevronDown, ChevronUp, Download, ArrowRight, AlertTriangle, Pencil, Check, X } from 'lucide-react';
import API_BASE_URL from '../config';

/**
 * Shown after upload to communicate the outcome of AI address correction.
 *
 * Props:
 *   corrections      – [{ name, original, corrected }]  (success case)
 *   correctedFile    – filename for /api/download/<file> (success case)
 *   correctionStatus – string from backend: 'ok' | 'rate_limit' | 'error' | 'skipped_*'
 *   onManualCorrect  – (schoolName, newAddress) => Promise<void>
 */
const AddressCorrectionBanner = ({ corrections = [], correctedFile, correctionStatus, onManualCorrect }) => {
    const [expanded, setExpanded] = useState(false);
    // { [schoolName]: { editing: bool, value: string, saving: bool, saved: bool } }
    const [editState, setEditState] = useState({});

    const isRateLimit = correctionStatus === 'rate_limit';
    const isError     = correctionStatus === 'error';
    const isWarning   = isRateLimit || isError;
    const isSuccess   = corrections.length > 0;

    if (!isSuccess && !isWarning) return null;

    const startEdit = (c) => {
        setEditState(prev => ({
            ...prev,
            [c.name]: { editing: true, value: c.corrected, saving: false, saved: false }
        }));
    };

    const cancelEdit = (name) => {
        setEditState(prev => ({ ...prev, [name]: { ...prev[name], editing: false } }));
    };

    const saveEdit = async (name) => {
        const entry = editState[name];
        if (!entry || !entry.value.trim()) return;
        setEditState(prev => ({ ...prev, [name]: { ...prev[name], saving: true } }));
        try {
            await onManualCorrect?.(name, entry.value.trim());
            setEditState(prev => ({ ...prev, [name]: { editing: false, value: entry.value.trim(), saving: false, saved: true } }));
        } catch {
            setEditState(prev => ({ ...prev, [name]: { ...prev[name], saving: false } }));
        }
    };

    // ----------------------------------------------------------------
    // Warning banner (rate limit or generic error)
    // ----------------------------------------------------------------
    if (isWarning && !isSuccess) {
        return (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                    <p className="font-semibold">
                        {isRateLimit
                            ? 'Limite del piano gratuito Gemini raggiunto'
                            : 'Correzione indirizzi non disponibile'}
                    </p>
                    <p className="mt-0.5 text-amber-700">
                        {isRateLimit
                            ? 'La correzione automatica degli indirizzi è stata saltata. Riprova domani — la quota si azzera ogni 24 ore. Nel frattempo il programma procede fidandosi degli indirizzi così come sono nel file.'
                            : "Si è verificato un errore durante la correzione degli indirizzi. Il programma procede con gli indirizzi originali."}
                    </p>
                </div>
            </div>
        );
    }

    // ----------------------------------------------------------------
    // Success banner (corrections applied)
    // ----------------------------------------------------------------
    const downloadUrl = `${API_BASE_URL}/api/download/${encodeURIComponent(correctedFile)}`;

    return (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 overflow-hidden">
            {/* Header row */}
            <div className="flex items-center justify-between px-4 py-3 gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <span className="text-sm font-semibold text-green-800">
                        AI ha corretto {corrections.length}{' '}
                        {corrections.length === 1 ? 'indirizzo' : 'indirizzi'}
                    </span>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                    {correctedFile && (
                        <a
                            href={downloadUrl}
                            download
                            className="flex items-center gap-1.5 text-xs font-medium text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-lg transition-colors"
                        >
                            <Download className="w-3.5 h-3.5" />
                            Scarica Excel corretto
                        </a>
                    )}
                    <button
                        onClick={() => setExpanded(v => !v)}
                        className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 font-medium px-2 py-1.5 rounded-lg hover:bg-green-100 transition-colors"
                    >
                        {expanded
                            ? <><ChevronUp className="w-4 h-4" /> Nascondi</>
                            : <><ChevronDown className="w-4 h-4" /> Dettagli</>
                        }
                    </button>
                </div>
            </div>

            {/* Expandable table */}
            {expanded && (
                <div className="border-t border-green-200 overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-green-100">
                            <tr>
                                <th className="px-4 py-2 text-left text-xs font-semibold text-green-700 uppercase tracking-wide w-1/4">Scuola</th>
                                <th className="px-4 py-2 text-left text-xs font-semibold text-green-700 uppercase tracking-wide w-[30%]">Originale</th>
                                <th className="px-1 py-2 w-6" />
                                <th className="px-4 py-2 text-left text-xs font-semibold text-green-700 uppercase tracking-wide">Indirizzo corretto (modificabile)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-green-100 bg-white">
                            {corrections.map((c, i) => {
                                const es = editState[c.name] || {};
                                const displayedAddress = es.saved ? es.value : c.corrected;
                                return (
                                    <tr key={i} className="hover:bg-green-50">
                                        <td className="px-4 py-2 text-gray-700 font-medium align-middle">{c.name}</td>
                                        <td className="px-4 py-2 text-gray-400 align-middle line-through text-xs">{c.original}</td>
                                        <td className="px-1 py-2 align-middle">
                                            <ArrowRight className="w-3.5 h-3.5 text-green-500" />
                                        </td>
                                        <td className="px-4 py-2 align-middle">
                                            {es.editing ? (
                                                <div className="flex items-center gap-1">
                                                    <input
                                                        type="text"
                                                        value={es.value}
                                                        onChange={e => setEditState(prev => ({
                                                            ...prev,
                                                            [c.name]: { ...prev[c.name], value: e.target.value }
                                                        }))}
                                                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(c.name); if (e.key === 'Escape') cancelEdit(c.name); }}
                                                        className="flex-1 text-xs px-2 py-1 border border-green-400 rounded focus:outline-none focus:ring-1 focus:ring-green-500"
                                                        autoFocus
                                                        disabled={es.saving}
                                                    />
                                                    <button onClick={() => saveEdit(c.name)} disabled={es.saving} className="p-1 text-green-600 hover:text-green-800" title="Salva">
                                                        <Check className="w-4 h-4" />
                                                    </button>
                                                    <button onClick={() => cancelEdit(c.name)} disabled={es.saving} className="p-1 text-gray-400 hover:text-gray-600" title="Annulla">
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-sm font-medium ${es.saved ? 'text-blue-700' : 'text-green-800'}`}>
                                                        {displayedAddress}
                                                    </span>
                                                    <button
                                                        onClick={() => startEdit(c)}
                                                        className="p-1 text-gray-400 hover:text-green-700 transition-colors"
                                                        title="Modifica indirizzo"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                    {es.saved && <span className="text-[10px] text-blue-500 font-medium">aggiornato</span>}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default AddressCorrectionBanner;
