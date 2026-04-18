import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, MapPin, CheckCircle, AlertTriangle, ChevronDown, ChevronUp, Database, X } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';

/**
 * DBMatchModal — shown after upload when uploaded schools have DB candidates.
 *
 * Props:
 *   matchList: [{ school, candidates }] from buildMatchList
 *   onResolved: (resolutions) => void
 *     resolutions: { [schoolId]: { lat, lon, address, name } | 'keep' }
 */
const DBMatchModal = ({ matchList, onResolved, onClose }) => {
    // selections[school.id] = { lat, lon, address, name } | 'keep' | undefined
    const [selections, setSelections] = useState({});
    // Which school cards have the manual correction input open
    const [manualOpen, setManualOpen] = useState({});
    // Text input values for manual correction
    const [manualInputs, setManualInputs] = useState({});

    const totalCount = matchList.length;
    const resolvedCount = Object.keys(selections).filter(id => selections[id] !== undefined).length;
    const allResolved = resolvedCount === totalCount;

    const selectCandidate = (schoolId, candidate) => {
        setSelections(prev => ({
            ...prev,
            [schoolId]: {
                lat: candidate.lat,
                lon: candidate.lon,
                address: candidate.address,
                name: candidate.name,
            },
        }));
        // Close manual correction if open
        setManualOpen(prev => ({ ...prev, [schoolId]: false }));
    };

    const markKeep = (schoolId) => {
        setSelections(prev => ({ ...prev, [schoolId]: 'keep' }));
        setManualOpen(prev => ({ ...prev, [schoolId]: false }));
    };

    const toggleManual = (schoolId) => {
        setManualOpen(prev => ({ ...prev, [schoolId]: !prev[schoolId] }));
        // Clear keep selection when opening manual
        if (!manualOpen[schoolId]) {
            setSelections(prev => {
                const next = { ...prev };
                if (next[schoolId] === 'keep') delete next[schoolId];
                return next;
            });
        }
    };

    const handleManualSelect = (schoolId, { address, lat, lon }) => {
        setManualInputs(prev => ({ ...prev, [schoolId]: address }));
        setSelections(prev => ({
            ...prev,
            [schoolId]: { lat, lon, address, name: address },
        }));
    };

    const handleManualChange = (schoolId, val) => {
        setManualInputs(prev => ({ ...prev, [schoolId]: val }));
        // Invalidate selection if user types after picking
        setSelections(prev => {
            const cur = prev[schoolId];
            if (cur && cur !== 'keep') {
                const next = { ...prev };
                delete next[schoolId];
                return next;
            }
            return prev;
        });
    };

    const handleConfirm = () => {
        onResolved(selections);
    };

    const getScoreLabel = (score) => {
        if (score >= 0.75) return { label: 'Alta', color: 'bg-green-500', textColor: 'text-green-700', bgColor: 'bg-green-50' };
        if (score >= 0.5) return { label: 'Media', color: 'bg-yellow-400', textColor: 'text-yellow-700', bgColor: 'bg-yellow-50' };
        return { label: 'Bassa', color: 'bg-gray-400', textColor: 'text-gray-600', bgColor: 'bg-gray-50' };
    };

    const isSelectedCandidate = (schoolId, candidate) => {
        const sel = selections[schoolId];
        return sel && sel !== 'keep' && sel.lat === candidate.lat && sel.lon === candidate.lon && sel.address === candidate.address;
    };

    const modal = (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-gray-100">
                    <div className="flex items-start gap-3">
                        <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0">
                            <Database className="w-5 h-5 text-blue-600" />
                        </div>
                        <div className="flex-1">
                            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                <Search className="w-4 h-4 text-blue-600" />
                                Verifica Indirizzi — Corrispondenze Database
                            </h2>
                            <p className="text-sm text-gray-500 mt-0.5">
                                Trovate <span className="font-semibold text-blue-600">{totalCount}</span> fermate con possibili corrispondenze.
                                Seleziona la corrispondenza corretta per ciascuna.
                            </p>
                        </div>
                        {onClose && (
                            <button
                                onClick={() => onClose(selections)}
                                className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600 transition-colors ml-auto flex-shrink-0"
                                title="Chiudi e salva progresso"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {/* Progress bar */}
                    <div className="mt-4">
                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>Risolte</span>
                            <span className="font-medium text-blue-600">{resolvedCount} / {totalCount}</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                            <div
                                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                                style={{ width: `${totalCount > 0 ? (resolvedCount / totalCount) * 100 : 0}%` }}
                            />
                        </div>
                    </div>
                </div>

                {/* School cards */}
                <div className="overflow-y-auto flex-1 p-6 space-y-4">
                    {matchList.map(({ school, candidates }) => {
                        const sel = selections[school.id];
                        const isKeep = sel === 'keep';
                        const isManualOpen = !!manualOpen[school.id];
                        const isResolved = sel !== undefined;

                        return (
                            <div
                                key={school.id}
                                className={`rounded-xl border p-4 transition-colors ${
                                    isKeep
                                        ? 'border-amber-200 bg-amber-50/40'
                                        : isResolved
                                        ? 'border-blue-200 bg-blue-50/30'
                                        : 'border-gray-200 bg-white'
                                }`}
                            >
                                {/* School info */}
                                <div className="mb-3">
                                    <div className="font-semibold text-gray-900 flex items-center gap-2">
                                        <span>🏫</span>
                                        {school.name}
                                        {isResolved && !isKeep && (
                                            <CheckCircle className="w-4 h-4 text-blue-500 ml-auto flex-shrink-0" />
                                        )}
                                        {isKeep && (
                                            <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                                                <AlertTriangle className="w-3 h-3" />
                                                Indirizzo non verificato
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                                        <MapPin className="w-3 h-3 flex-shrink-0" />
                                        Indirizzo caricato: <span className="font-mono ml-1">{school.address}</span>
                                    </div>
                                </div>

                                {/* Candidates */}
                                <div className="space-y-2 mb-3">
                                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Corrispondenze trovate:</div>
                                    {candidates.map((candidate, idx) => {
                                        const score = candidate._matchScore;
                                        const pct = Math.round(score * 100);
                                        const { label, color, textColor, bgColor } = getScoreLabel(score);
                                        const isSelected = isSelectedCandidate(school.id, candidate);

                                        return (
                                            <button
                                                key={idx}
                                                onClick={() => selectCandidate(school.id, candidate)}
                                                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-all ${
                                                    isSelected
                                                        ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400'
                                                        : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/40'
                                                }`}
                                            >
                                                <div className="flex items-start gap-3">
                                                    {/* Radio indicator */}
                                                    <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                                                        isSelected ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                                                    }`}>
                                                        {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                                    </div>

                                                    {/* Name + address */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium text-gray-900 truncate">{candidate.name}</div>
                                                        <div className="text-xs text-gray-500 truncate">{candidate.address}</div>
                                                    </div>

                                                    {/* Confidence bar */}
                                                    <div className="flex-shrink-0 w-28 flex flex-col items-end gap-1">
                                                        <span className={`text-xs font-semibold ${textColor}`}>{pct}%</span>
                                                        <div className={`w-full h-1.5 rounded-full ${bgColor} overflow-hidden`}>
                                                            <div
                                                                className={`h-full rounded-full ${color}`}
                                                                style={{ width: `${pct}%` }}
                                                            />
                                                        </div>
                                                        <span className={`text-[10px] font-medium ${textColor}`}>{label}</span>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Manual correction toggle */}
                                <div className="space-y-2">
                                    <button
                                        onClick={() => toggleManual(school.id)}
                                        className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                                    >
                                        <span>⌨</span>
                                        Correggi manualmente
                                        {isManualOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                    </button>

                                    {isManualOpen && (
                                        <div className="mt-2">
                                            <AddressAutocomplete
                                                value={manualInputs[school.id] || ''}
                                                onChange={(val) => handleManualChange(school.id, val)}
                                                onSelect={(sel) => handleManualSelect(school.id, sel)}
                                                placeholder={`Cerca indirizzo per "${school.name}"...`}
                                            />
                                        </div>
                                    )}

                                    {/* Keep as-is button */}
                                    {!isKeep && (
                                        <button
                                            onClick={() => markKeep(school.id)}
                                            className="flex items-center gap-1.5 text-xs text-amber-600 hover:text-amber-800 font-medium transition-colors"
                                        >
                                            <AlertTriangle className="w-3.5 h-3.5" />
                                            Mantieni così (non verificato)
                                        </button>
                                    )}
                                    {isKeep && (
                                        <button
                                            onClick={() => setSelections(prev => { const n = { ...prev }; delete n[school.id]; return n; })}
                                            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 font-medium transition-colors"
                                        >
                                            ↩ Annulla scelta
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-gray-100 flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-400">
                        Le fermate &quot;mantenute&quot; useranno le coordinate originali, potenzialmente imprecise.
                    </p>
                    <button
                        onClick={handleConfirm}
                        disabled={!allResolved}
                        className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
                            allResolved
                                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                    >
                        CONFERMA E PROCESSA ({resolvedCount}/{totalCount} risolte)
                    </button>
                </div>
            </div>
        </div>
    );

    return createPortal(modal, document.body);
};

export default DBMatchModal;
