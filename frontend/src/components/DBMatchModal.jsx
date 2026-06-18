import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, MapPin, CheckCircle, AlertTriangle, ChevronDown, ChevronUp, Database, X, Trash2, Zap, Edit2, Loader2, Save } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';
import { getBestDefaultCandidate } from '../utils/matchInstitutes';
import API_BASE_URL from '../config';

const DBMatchModal = ({ matchList, onResolved, onClose }) => {
    const listRef = useRef(null);

    const scrollToNextUnresolved = () => {
        if (!listRef.current) return;
        const unresolved = listRef.current.querySelectorAll('[data-unresolved="true"]');
        let target = unresolved[0];
        for (const el of unresolved) {
            if (el.offsetTop > listRef.current.scrollTop + 50) {
                target = el;
                break;
            }
        }
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    // selections[school.id] = { lat, lon, address, name, saveToDb, needsConfirmation? } | 'keep' | undefined
    const [selections, setSelections] = useState(() => {
        const initial = {};
        matchList.forEach(({ school, candidates }) => {
            const best = getBestDefaultCandidate(school, candidates);
            // Real tie: top two scores within 5% of each other AND both are reasonably high (>= 0.5)
            const hasTie = candidates.length > 1
                && Math.abs(candidates[0]._matchScore - candidates[1]._matchScore) < 0.05
                && candidates[1]._matchScore >= 0.5;
            
            if (school.is_autonomous) {
                initial[school.id] = { discard: true, needsConfirmation: true };
            } else if (best) {
                initial[school.id] = {
                    lat: best.lat,
                    lon: best.lon,
                    address: best.address,
                    name: best.name,
                    saveToDb: false,
                    needsConfirmation: hasTie
                };
            }
        });
        return initial;
    });

    // Which action is active per school: 'ai' or 'manual' or null
    const [activeActions, setActiveActions] = useState({});
    
    // AI suggestions per school
    const [aiSuggestions, setAiSuggestions] = useState({});
    const [loadingAi, setLoadingAi] = useState({});

    // Manual address input values (controlled)
    const [manualInputs, setManualInputs] = useState({});

    // Staged candidates for AI and Manual (before confirmation)
    const [stagedCandidates, setStagedCandidates] = useState({});

    const totalCount = matchList.length;
    // Only count as resolved if not undefined AND does not need confirmation
    const resolvedCount = Object.keys(selections).filter(id => {
        const sel = selections[id];
        return sel !== undefined && (!sel.needsConfirmation);
    }).length;
    const allResolved = resolvedCount === totalCount;

    const selectCandidate = (schoolId, candidate, isNew = false, fromDbList = false) => {
        setSelections(prev => ({
            ...prev,
            [schoolId]: {
                lat: candidate.lat,
                lon: candidate.lon,
                address: candidate.address || candidate.description || candidate.name,
                name: candidate.name || candidate.address || candidate.description,
                saveToDb: isNew,
                needsConfirmation: false,
                isCustom: !fromDbList
            },
        }));
        
        setActiveActions({});
    };

    const resetSelection = (schoolId, school, candidates) => {
        setSelections(prev => {
            const next = { ...prev };
            const best = getBestDefaultCandidate(school, candidates);
            const hasTie = candidates.length > 1
                && Math.abs(candidates[0]._matchScore - candidates[1]._matchScore) < 0.05
                && candidates[1]._matchScore >= 0.5;

            if (best) {
                next[schoolId] = {
                    lat: best.lat,
                    lon: best.lon,
                    address: best.address,
                    name: best.name,
                    saveToDb: false,
                    needsConfirmation: hasTie
                };
            } else {
                delete next[schoolId];
            }
            return next;
        });
        setActiveActions({});
        setStagedCandidates(prev => {
            const next = { ...prev };
            delete next[schoolId];
            return next;
        });
    };

    const toggleSaveToDb = (schoolId) => {
        setSelections(prev => {
            const sel = prev[schoolId];
            if (!sel || sel === 'keep') return prev;
            return {
                ...prev,
                [schoolId]: { ...sel, saveToDb: !sel.saveToDb }
            };
        });
    };

    const markKeep = (schoolId) => {
        setSelections(prev => ({ ...prev, [schoolId]: 'keep' }));
        setActiveActions(prev => {
            const next = { ...prev };
            delete next[schoolId];
            return next;
        });
    };

    const markDiscard = (schoolId) => {
        setSelections(prev => ({ ...prev, [schoolId]: { discard: true, needsConfirmation: false } }));
        setActiveActions(prev => {
            const next = { ...prev };
            delete next[schoolId];
            return next;
        });
    };

    const handleActionToggle = async (schoolId, type, schoolAddress) => {
        setActiveActions(prev => {
            if (prev[schoolId] === type) {
                return {}; // Toggle off
            }
            return { [schoolId]: type }; // Exclusive active action
        });
        
        setStagedCandidates(prev => {
            const next = { ...prev };
            delete next[schoolId];
            return next;
        });
        
        // Clear keep selection
        setSelections(prev => {
            const next = { ...prev };
            if (next[schoolId] === 'keep') delete next[schoolId];
            return next;
        });

        if (type === 'ai' && !aiSuggestions[schoolId]) {
            setLoadingAi(prev => ({ ...prev, [schoolId]: true }));
            try {
                const res = await fetch(`${API_BASE_URL}/api/ai_suggest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: schoolAddress })
                });
                const data = await res.json();
                setAiSuggestions(prev => ({ ...prev, [schoolId]: data.suggestions || [] }));
            } catch (err) {
                console.error(err);
            } finally {
                setLoadingAi(prev => ({ ...prev, [schoolId]: false }));
            }
        }
    };

    const handleStageCandidate = (schoolId, candidate, defaultSaveToDb = true) => {
        setStagedCandidates(prev => ({
            ...prev,
            [schoolId]: { ...candidate, saveToDb: defaultSaveToDb }
        }));
    };

    const handleManualSelect = (schoolId, { address, lat, lon }) => {
        setManualInputs(prev => ({ ...prev, [schoolId]: address }));
        handleStageCandidate(schoolId, { lat, lon, address, name: address }, true);
    };

    const handleManualChange = (schoolId, val) => {
        setManualInputs(prev => ({ ...prev, [schoolId]: val }));
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
        return sel && sel !== 'keep' && !sel.discard && Math.abs(sel.lat - candidate.lat) < 0.0001 && Math.abs(sel.lon - candidate.lon) < 0.0001 && sel.name === candidate.name;
    };

    const modal = (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className={`bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex overflow-hidden`} style={{ maxHeight: '90vh' }}>
                
                {/* Left Column: List */}
                <div className={`flex-1 w-full max-w-3xl flex flex-col bg-white overflow-hidden`}>
                    
                    {/* Header */}
                    <div className="p-5 border-b border-gray-100 flex-shrink-0">
                        <div className="flex items-start gap-3">
                            <div className="p-2 bg-blue-100 rounded-lg flex-shrink-0">
                                <Database className="w-5 h-5 text-blue-600" />
                            </div>
                            <div className="flex-1">
                                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                    Verifica Indirizzi — Corrispondenze Database
                                </h2>
                                <p className="text-sm text-gray-600 mt-1 font-medium bg-blue-50 text-blue-800 p-2 rounded-md">
                                    Controlla se gli indirizzi individuati sono corretti, puoi selezionarne un altro o correggerlo.
                                </p>
                            </div>
                            {onClose && (
                                <button
                                    onClick={() => onClose(selections)}
                                    className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600 transition-colors ml-auto flex-shrink-0"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>

                        {/* Progress bar */}
                        <div className="mt-4">
                            <div className="flex justify-between items-end mb-1">
                                <div className="text-xs text-gray-500">
                                    <span>Risolte</span>
                                    <span className="font-medium text-blue-600 ml-2">{resolvedCount} / {totalCount}</span>
                                </div>
                                {resolvedCount < totalCount && (
                                    <button 
                                        onClick={scrollToNextUnresolved}
                                        className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                                    >
                                        <ChevronDown className="w-3 h-3" />
                                        Vai al prossimo
                                    </button>
                                )}
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                                <div
                                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                                    style={{ width: `${totalCount > 0 ? (resolvedCount / totalCount) * 100 : 0}%` }}
                                />
                            </div>
                        </div>
                    </div>

                    {/* School cards */}
                    <div ref={listRef} className="overflow-y-auto flex-1 p-5 space-y-4">
                        {matchList.map(({ school, candidates }) => {
                            const sel = selections[school.id];
                            const isKeep = sel === 'keep';
                            const isDiscard = sel && sel.discard === true;
                            const activeAct = activeActions[school.id];
                            const isTie = sel && sel.needsConfirmation && !isDiscard;
                            const isResolved = sel !== undefined && !sel.needsConfirmation;

                            return (
                                <div
                                    key={school.id}
                                    data-unresolved={!isResolved && !isKeep && !isDiscard}
                                    className={`rounded-xl border p-4 transition-colors ${
                                        isDiscard
                                            ? 'border-gray-200 bg-gray-50/50 opacity-80'
                                            : isKeep
                                            ? 'border-amber-200 bg-amber-50/40'
                                            : isTie
                                            ? 'border-orange-200 bg-orange-50/30'
                                            : sel && sel.needsConfirmation && isDiscard
                                            ? 'border-red-200 bg-red-50/30'
                                            : isResolved
                                            ? 'border-blue-200 bg-blue-50/30'
                                            : 'border-gray-200 bg-white'
                                    }`}
                                >
                                    {/* School info */}
                                    <div className="mb-3">
                                        <div className="font-semibold text-gray-900 flex items-center gap-2">
                                            <span>🏫</span>
                                            {school.name.replace(/\(.*?\)/g, '').trim()}
                                            {isResolved && !isKeep && !isDiscard && (
                                                <CheckCircle className="w-4 h-4 text-blue-500 ml-auto flex-shrink-0" />
                                            )}
                                            {isResolved && isDiscard && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">
                                                    <Trash2 className="w-3 h-3" />
                                                    Rimossa
                                                </span>
                                            )}
                                            {isKeep && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Usa originale
                                                </span>
                                            )}
                                            {isTie && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-100 px-2 py-0.5 rounded-full shadow-sm">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Più opzioni valide
                                                </span>
                                            )}
                                            {sel && sel.needsConfirmation && isDiscard && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-red-600 bg-red-100 px-2 py-0.5 rounded-full shadow-sm">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Conferma scarto
                                                </span>
                                            )}
                                            {!isResolved && !isTie && !isKeep && !isDiscard && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-100 px-2 py-0.5 rounded-full">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Da controllare
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                            <MapPin className="w-3 h-3 flex-shrink-0" />
                                            Indirizzo file: <span className="font-mono ml-1">{school.address}</span>
                                        </div>
                                    </div>

                                    {/* Autonomous Alert */}
                                    {sel && sel.needsConfirmation && isDiscard && (
                                        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                                            <div className="flex items-start gap-2">
                                                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                                                <div className="flex-1">
                                                    <h4 className="text-sm font-semibold text-red-800">Possibile viaggio in autonomia</h4>
                                                    <p className="text-xs text-red-600 mt-1">Questa scuola sembra aver indicato di raggiungere la destinazione in autonomia. Vuoi scartarla dal piano dei trasporti?</p>
                                                    <div className="mt-3 flex gap-2">
                                                        <button 
                                                            onClick={() => markDiscard(school.id)}
                                                            className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-md hover:bg-red-700 transition-colors shadow-sm"
                                                        >
                                                            Conferma e scarta
                                                        </button>
                                                        <button 
                                                            onClick={() => {
                                                                const best = getBestDefaultCandidate(school, candidates);
                                                                if (best) selectCandidate(school.id, best, false, true);
                                                                else setActiveActions({ [school.id]: 'manual' });
                                                            }}
                                                            className="px-3 py-1.5 bg-white text-red-700 border border-red-200 text-xs font-medium rounded-md hover:bg-red-50 transition-colors"
                                                        >
                                                            No, mantieni
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* DB Candidates */}
                                    {candidates.length > 0 && !isDiscard && (
                                        <div className="space-y-2 mb-3">
                                            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Corrispondenze DB:</div>
                                            {[...candidates].sort((a, b) => b._matchScore - a._matchScore).map((candidate, idx) => {
                                                const score = candidate._matchScore;
                                                const pct = Math.round(score * 100);
                                                const { label, color, textColor, bgColor } = getScoreLabel(score);
                                                const isSelected = isSelectedCandidate(school.id, candidate);
                                                const isSelectedTie = isSelected && isTie;

                                                return (
                                                    <button
                                                        key={idx}
                                                        onClick={() => selectCandidate(school.id, candidate, false, true)}
                                                        className={`w-full text-left rounded-lg border px-3 py-2.5 transition-all ${
                                                            isSelectedTie
                                                                ? 'border-orange-500 bg-orange-50 ring-1 ring-orange-400 shadow-sm'
                                                                : isSelected
                                                                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400 shadow-sm'
                                                                : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/40'
                                                        }`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-sm font-medium text-gray-900 truncate">
                                                                    {candidate.name || '-'}
                                                                </div>
                                                                <div className="text-xs text-gray-500 truncate mt-0.5">
                                                                    {candidate.address || '-'}
                                                                </div>
                                                                {candidate.description && (
                                                                    <div className="text-xs text-gray-400 truncate mt-0.5 italic">
                                                                        Info: {candidate.description}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                                                                <div className="w-10 text-right">
                                                                    <span className={`text-xs font-semibold ${textColor}`}>{pct}%</span>
                                                                </div>
                                                                <div className={`w-12 h-1.5 rounded-full ${bgColor} overflow-hidden`}>
                                                                    <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Action Buttons */}
                                    {!isDiscard && (
                                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                                            <button
                                                onClick={() => handleActionToggle(school.id, 'ai', school.address)}
                                                className={`flex-1 flex justify-center items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors border ${
                                                    activeAct === 'ai' 
                                                    ? 'bg-purple-50 text-purple-700 border-purple-200' 
                                                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                                                }`}
                                            >
                                                <Zap className={`w-3.5 h-3.5 ${activeAct === 'ai' ? 'text-purple-500' : ''}`} />
                                                Correggi con AI
                                            </button>
                                            <button
                                                onClick={() => handleActionToggle(school.id, 'manual', school.address)}
                                                className={`flex-1 flex justify-center items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors border ${
                                                    activeAct === 'manual' 
                                                    ? 'bg-blue-50 text-blue-700 border-blue-200' 
                                                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                                                }`}
                                            >
                                                <Edit2 className="w-3.5 h-3.5" />
                                                Scrivi indirizzo o coord.
                                            </button>
                                        </div>
                                    )}

                                    {/* Custom Selection Box */}
                                    {sel && sel.isCustom && !isDiscard && !activeAct && (
                                        <div className="mt-3 p-3 bg-blue-50/80 border border-blue-200 rounded-lg flex items-center justify-between animate-in fade-in">
                                            <div className="min-w-0 pr-3">
                                                <div className="text-[10px] font-bold text-blue-800 uppercase tracking-wide mb-0.5 flex items-center gap-1">
                                                    <CheckCircle className="w-3 h-3" /> Scelta Personalizzata
                                                </div>
                                                <div className="text-sm font-semibold text-gray-900 truncate" title={sel.name}>{sel.name}</div>
                                                {(sel.address && sel.address !== sel.name) && (
                                                    <div className="text-xs text-gray-500 truncate" title={sel.address}>{sel.address}</div>
                                                )}
                                            </div>
                                            <button 
                                                onClick={() => resetSelection(school.id, school, candidates)}
                                                className="flex-shrink-0 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                                title="Elimina inserimento e ripristina default"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}

                                    {/* Expanded Action Panel */}
                                    {activeAct === 'ai' && (
                                        <div className="mt-3 p-3 bg-purple-50/50 rounded-lg border border-purple-100 animate-in fade-in slide-in-from-top-2">
                                            <div className="text-xs font-medium text-purple-800 mb-2">Suggerimenti AI</div>
                                            {loadingAi[school.id] ? (
                                                <div className="flex items-center gap-2 text-purple-600 text-sm p-4 justify-center">
                                                    <Loader2 className="w-4 h-4 animate-spin" /> Ricerca varianti...
                                                </div>
                                            ) : (aiSuggestions[school.id] || []).length > 0 ? (
                                                <div className="space-y-2">
                                                    {aiSuggestions[school.id].map((sug, idx) => {
                                                        const staged = stagedCandidates[school.id];
                                                        const isStaged = staged && staged.lat === sug.lat && staged.lon === sug.lon;
                                                        return (
                                                            <div key={idx} className="flex gap-1">
                                                                <button
                                                                    onClick={() => handleStageCandidate(school.id, { lat: sug.lat, lon: sug.lon, address: sug.description, name: school.name })}
                                                                    className={`flex-1 text-left rounded-md border px-3 py-2 transition-all shadow-sm ${
                                                                        isStaged 
                                                                        ? 'border-purple-500 ring-2 ring-purple-300 bg-purple-50' 
                                                                        : 'border-purple-200 bg-white hover:bg-purple-50'
                                                                    }`}
                                                                >
                                                                    <div className={`text-sm font-medium truncate ${isStaged ? 'text-purple-900' : 'text-gray-800'}`}>
                                                                        {sug.structured_formatting?.main_text || sug.description}
                                                                    </div>
                                                                    <div className="text-xs text-gray-500 truncate mt-0.5">{sug.structured_formatting?.secondary_text}</div>
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="flex flex-col items-center justify-center py-6 text-center animate-in fade-in">
                                                    <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
                                                    <h3 className="text-lg font-bold text-gray-900 mb-1">Nessuna soluzione trovata dall'AI!</h3>
                                                    <p className="text-xs text-gray-600 max-w-xs mb-4">
                                                        Prova ad inserire l'indirizzo manualmente o utilizza le coordinate GPS.
                                                    </p>
                                                    <button 
                                                        onClick={() => handleActionToggle(school.id, 'manual', null)}
                                                        className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-1.5 px-4 rounded-lg shadow-sm mb-4 transition-colors text-sm"
                                                    >
                                                        Inserisci a mano
                                                    </button>
                                                    
                                                    <div className="w-full max-w-sm bg-gray-900 rounded-xl overflow-hidden shadow border border-gray-200">
                                                        <div className="bg-gray-800 px-3 py-1.5 text-[10px] font-medium text-gray-300 border-b border-gray-700 flex items-center gap-1.5">
                                                            <span>💡</span> Tutorial: Come ottenere le coordinate da Google Maps
                                                        </div>
                                                        <video 
                                                            src="/assets/tutorial/tutorial_copy_coordinates.mov" 
                                                            controls 
                                                            className="w-full aspect-video outline-none"
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                            
                                            {/* AI Confirmation UI */}
                                            {stagedCandidates[school.id] && activeAct === 'ai' && (
                                                <div className="mt-4 pt-3 border-t border-purple-200/50 flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2">
                                                    <label className="flex items-center gap-2 cursor-pointer group">
                                                        <input 
                                                            type="checkbox" 
                                                            checked={stagedCandidates[school.id].saveToDb}
                                                            onChange={() => setStagedCandidates(prev => ({
                                                                ...prev,
                                                                [school.id]: { ...prev[school.id], saveToDb: !prev[school.id].saveToDb }
                                                            }))}
                                                            className="rounded border-purple-300 text-purple-600 focus:ring-purple-500 cursor-pointer" 
                                                        />
                                                        <span className="text-xs font-medium text-purple-800 group-hover:text-purple-900 transition-colors flex items-center gap-1.5">
                                                            <Save className="w-3.5 h-3.5 text-purple-500" />
                                                            Salva questo indirizzo nel database
                                                        </span>
                                                    </label>
                                                    <button
                                                        onClick={() => {
                                                            const c = stagedCandidates[school.id];
                                                            selectCandidate(school.id, c, c.saveToDb);
                                                        }}
                                                        className="w-full bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium py-2 rounded-lg shadow-sm transition-colors"
                                                    >
                                                        Conferma questo indirizzo
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeAct === 'manual' && (
                                        <div className="mt-3 p-3 bg-blue-50/50 rounded-lg border border-blue-100 animate-in fade-in slide-in-from-top-2">
                                            <div className="text-xs font-medium text-blue-800 mb-2">Cerca indirizzo o inserisci coordinate</div>
                                            <AddressAutocomplete
                                                value={manualInputs[school.id] || ''}
                                                onChange={(val) => handleManualChange(school.id, val)}
                                                onSelect={(data) => handleManualSelect(school.id, data)}
                                                placeholder="Cerca via, città o 'lat, lon'"
                                            />
                                            
                                            {/* Manual Confirmation UI */}
                                            {stagedCandidates[school.id] && activeAct === 'manual' && (
                                                <div className="mt-4 pt-3 border-t border-blue-200/50 flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2">
                                                    <label className="flex items-center gap-2 cursor-pointer group">
                                                        <input 
                                                            type="checkbox" 
                                                            checked={stagedCandidates[school.id].saveToDb}
                                                            onChange={() => setStagedCandidates(prev => ({
                                                                ...prev,
                                                                [school.id]: { ...prev[school.id], saveToDb: !prev[school.id].saveToDb }
                                                            }))}
                                                            className="rounded border-blue-300 text-blue-600 focus:ring-blue-500 cursor-pointer" 
                                                        />
                                                        <span className="text-xs font-medium text-blue-800 group-hover:text-blue-900 transition-colors flex items-center gap-1.5">
                                                            <Save className="w-3.5 h-3.5 text-blue-500" />
                                                            Salva questo indirizzo nel database
                                                        </span>
                                                    </label>
                                                    <button
                                                        onClick={() => {
                                                            const c = stagedCandidates[school.id];
                                                            selectCandidate(school.id, c, c.saveToDb);
                                                        }}
                                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg shadow-sm transition-colors"
                                                    >
                                                        Conferma questo indirizzo
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Keep fallback */}
                                    {!isResolved && !isKeep && !isDiscard && (
                                        <div className="flex gap-2 mt-2">
                                            <button
                                                onClick={() => markKeep(school.id)}
                                                className="flex-1 text-center text-xs font-medium text-gray-500 hover:text-gray-700 py-1 transition-colors bg-gray-50 rounded-md hover:bg-gray-100 border border-transparent"
                                            >
                                                Usa originale
                                            </button>
                                            <button
                                                onClick={() => markDiscard(school.id)}
                                                className="flex-1 text-center text-xs font-medium text-red-500 hover:text-red-700 py-1 transition-colors bg-red-50 rounded-md hover:bg-red-100 border border-transparent inline-flex items-center justify-center gap-1"
                                            >
                                                <Trash2 className="w-3 h-3" />
                                                Rimuovi
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Footer */}
                    <div className="p-5 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between flex-shrink-0">
                        <div className="text-sm text-gray-500">
                            {allResolved ? (
                                <span className="text-green-600 font-medium flex items-center gap-1.5">
                                    <CheckCircle className="w-4 h-4" /> Tutte le fermate verificate
                                </span>
                            ) : (
                                <span>Verifica tutte le fermate per procedere</span>
                            )}
                        </div>
                        <button
                            onClick={handleConfirm}
                            disabled={!allResolved}
                            className={`px-5 py-2 rounded-lg font-medium transition-all ${
                                allResolved
                                    ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-200'
                                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                        >
                            Conferma Selezioni
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(modal, document.body);
};

export default DBMatchModal;
