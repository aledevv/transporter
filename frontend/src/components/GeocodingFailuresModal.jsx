import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, SkipForward } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';

/**
 * Modal shown when one or more addresses couldn't be geocoded automatically.
 * The user can manually search and pick each address.
 *
 * Props:
 *   failures: [{id, name, address, ...}]
 *   onResolve: (corrections: {[id]: {lat, lon}}) => void
 */
const GeocodingFailuresModal = ({ failures, onResolve }) => {
    // Map: id -> { display: string, lat: string, lon: string } | null
    const [corrections, setCorrections] = useState(() =>
        Object.fromEntries(failures.map(f => [f.id, null]))
    );
    // Text values for each input (uncontrolled display string)
    const [inputValues, setInputValues] = useState(() =>
        Object.fromEntries(failures.map(f => [f.id, '']))
    );

    const resolvedCount = Object.values(corrections).filter(Boolean).length;
    const allResolved = resolvedCount === failures.length;

    const handleSelect = (id, { address, lat, lon }) => {
        setCorrections(prev => ({ ...prev, [id]: { lat, lon } }));
        setInputValues(prev => ({ ...prev, [id]: address }));
    };

    const handleChange = (id, val) => {
        setInputValues(prev => ({ ...prev, [id]: val }));
        // If user edits after picking, invalidate the selection
        setCorrections(prev => ({ ...prev, [id]: null }));
    };

    const handleSkip = (id) => {
        // Skip with Trento fallback coords
        setCorrections(prev => ({ ...prev, [id]: { lat: '46.0697', lon: '11.1211', skipped: true } }));
        setInputValues(prev => ({ ...prev, [id]: '(ignorato — Trento)' }));
    };

    const handleConfirm = () => {
        onResolve(corrections);
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-gray-100">
                    <div className="flex items-start gap-3">
                        <div className="p-2 bg-orange-100 rounded-lg flex-shrink-0">
                            <AlertTriangle className="w-5 h-5 text-orange-600" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-gray-900">
                                {failures.length === 1
                                    ? '1 indirizzo non trovato'
                                    : `${failures.length} indirizzi non trovati`}
                            </h2>
                            <p className="text-sm text-gray-500 mt-0.5">
                                Cerca l'indirizzo corretto per ciascuna fermata. Puoi anche ignorarle e correggerle dopo.
                            </p>
                        </div>
                    </div>

                    {/* Progress bar */}
                    <div className="mt-4">
                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>Risolti</span>
                            <span className="font-medium text-blue-600">{resolvedCount} / {failures.length}</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                            <div
                                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                                style={{ width: `${(resolvedCount / failures.length) * 100}%` }}
                            />
                        </div>
                    </div>
                </div>

                {/* List */}
                <div className="overflow-y-auto flex-1 p-6 space-y-4">
                    {failures.map((f) => {
                        const isResolved = !!corrections[f.id];
                        const isSkipped = corrections[f.id]?.skipped;
                        return (
                            <div
                                key={f.id}
                                className={`rounded-xl border p-4 transition-colors ${
                                    isSkipped
                                        ? 'border-gray-200 bg-gray-50'
                                        : isResolved
                                        ? 'border-green-200 bg-green-50'
                                        : 'border-orange-100 bg-orange-50/40'
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2 mb-2">
                                    <div>
                                        <div className="font-semibold text-gray-900 text-sm">{f.name}</div>
                                        <div className="text-xs text-gray-400 mt-0.5">
                                            Originale: <span className="font-mono">{f.address}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {isResolved && !isSkipped && (
                                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                                        )}
                                        {!isResolved && (
                                            <button
                                                onClick={() => handleSkip(f.id)}
                                                className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                                                title="Ignora (userà Trento come riferimento)"
                                            >
                                                <SkipForward className="w-3.5 h-3.5" />
                                                Ignora
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {!isSkipped && (
                                    <AddressAutocomplete
                                        value={inputValues[f.id]}
                                        onChange={(val) => handleChange(f.id, val)}
                                        onSelect={(sel) => handleSelect(f.id, sel)}
                                        placeholder={`Cerca "${f.address}"...`}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-gray-100 flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-400">
                        Gli indirizzi ignorati useranno Trento come riferimento approssimativo.
                    </p>
                    <button
                        onClick={handleConfirm}
                        disabled={!allResolved}
                        className={`px-5 py-2.5 rounded-xl font-semibold text-sm transition-all ${
                            allResolved
                                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                    >
                        Conferma e continua
                    </button>
                </div>
            </div>
        </div>
    );
};

export default GeocodingFailuresModal;
