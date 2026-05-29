import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, MapPin, CheckCircle, AlertTriangle, ChevronDown, ChevronUp, Database, X, Zap, Edit2, Loader2, Save } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';
import { getBestDefaultCandidate } from '../utils/matchInstitutes';
import API_BASE_URL from '../config';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix leaflet icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const createIcon = (isSelected) => new L.DivIcon({
    className: 'custom-leaflet-icon',
    html: `<div style="
        width: 20px; 
        height: 20px; 
        background-color: ${isSelected ? '#f59e0b' : '#3b82f6'}; 
        border: 3px solid white; 
        border-radius: 50%; 
        box-shadow: 0 2px 4px rgba(0,0,0,0.4);
        transition: all 0.3s ease;
        ${isSelected ? 'transform: scale(1.2); z-index: 100;' : ''}
    "></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
});

// A component to automatically pan/zoom the map to the active pins
const MapController = ({ pins }) => {
    const map = useMap();
    useEffect(() => {
        if (!pins || pins.length === 0) return;
        const activePin = pins.find(p => p.isSelected);
        
        if (activePin) {
            map.flyTo([activePin.lat, activePin.lon], 16, { animate: true, duration: 1.5 });
        } else if (pins.length > 0) {
            const bounds = L.latLngBounds(pins.map(p => [p.lat, p.lon]));
            map.flyToBounds(bounds, { animate: true, duration: 1.5, padding: [50, 50] });
        }
    }, [pins, map]);
    
    // Invalidate size when container resizes
    useEffect(() => {
        const timeout = setTimeout(() => {
            map.invalidateSize();
        }, 400); // Wait for CSS transition
        return () => clearTimeout(timeout);
    }, [map]);
    return null;
};

const DBMatchModal = ({ matchList, onResolved, onClose }) => {
    // selections[school.id] = { lat, lon, address, name, saveToDb, needsConfirmation? } | 'keep' | undefined
    const [selections, setSelections] = useState(() => {
        const initial = {};
        matchList.forEach(({ school, candidates }) => {
            const best = getBestDefaultCandidate(school, candidates);
            // Consider it a tie if the top two candidates have very similar scores
            const hasTie = candidates.length > 1 && Math.abs(candidates[0]._matchScore - candidates[1]._matchScore) < 0.001;
            
            if (best) {
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

    // Map state
    const [mapCenter] = useState([46.0697, 11.1211]); // static initial center
    const [mapReady, setMapReady] = useState(false); // Delay map render for animation
    const [mapHidden, setMapHidden] = useState(false);
    const isMapVisible = Object.keys(activeActions).length > 0 && !mapHidden;

    // Delay map mount for smooth animation
    useEffect(() => {
        if (isMapVisible && !mapReady) {
            const t = setTimeout(() => setMapReady(true), 100);
            return () => clearTimeout(t);
        }
        if (!isMapVisible) {
            const t = setTimeout(() => setMapReady(false), 500);
            return () => clearTimeout(t);
        }
    }, [isMapVisible]);

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
                needsConfirmation: false
            },
        }));
        
        if (!fromDbList) {
            setActiveActions({}); // Clear actions if confirming from AI or Manual
        } else {
            // Keep map open for DB candidate selection
            setMapHidden(false);
            setActiveActions({ [schoolId]: 'map' });
        }
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

    const handleActionToggle = async (schoolId, type, schoolAddress) => {
        setMapHidden(false);
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

    const handleShowMap = (schoolId) => {
        setMapHidden(false);
        setActiveActions({ [schoolId]: 'map' });
    };

    const handleStageCandidate = (schoolId, candidate, defaultSaveToDb = true) => {
        setMapHidden(false);
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
        return sel && sel !== 'keep' && Math.abs(sel.lat - candidate.lat) < 0.0001 && Math.abs(sel.lon - candidate.lon) < 0.0001 && sel.name === candidate.name;
    };

    const activeSchoolIdForMap = Object.keys(activeActions)[0];
    const mapPins = React.useMemo(() => {
        if (!activeSchoolIdForMap) return [];
        const act = activeActions[activeSchoolIdForMap];
        const sel = selections[activeSchoolIdForMap];
        const staged = stagedCandidates[activeSchoolIdForMap];

        if (act === 'ai') {
            const sugs = aiSuggestions[activeSchoolIdForMap] || [];
            return sugs.map((s, idx) => {
                const isSelected = staged && staged.lat === s.lat && staged.lon === s.lon;
                return { id: `ai_${idx}`, lat: s.lat, lon: s.lon, title: s.structured_formatting?.main_text || s.description, desc: s.structured_formatting?.secondary_text, isAi: true, isSelected, raw: s };
            });
        } else if (act === 'manual') {
            if (staged) return [{ id: 'manual', lat: staged.lat, lon: staged.lon, title: staged.name, desc: staged.address, isManual: true, isSelected: true, raw: staged }];
            return [];
        } else {
            const schoolObj = matchList.find(m => m.school.id === activeSchoolIdForMap);
            if (!schoolObj) return [];
            return schoolObj.candidates.map((c, idx) => {
                const isSelected = sel && sel !== 'keep' && Math.abs(sel.lat - c.lat) < 0.0001 && Math.abs(sel.lon - c.lon) < 0.0001;
                return { id: `db_${idx}`, lat: c.lat, lon: c.lon, title: c.name, desc: c.address, isDb: true, isSelected, raw: c };
            });
        }
    }, [activeSchoolIdForMap, activeActions, selections, stagedCandidates, aiSuggestions, matchList]);

    const handleMapPinClick = (pin) => {
        if (!activeSchoolIdForMap) return;
        if (pin.isAi) {
            handleStageCandidate(activeSchoolIdForMap, { lat: pin.lat, lon: pin.lon, address: pin.raw.description, name: 'Suggerimento AI' });
        } else if (pin.isDb) {
            selectCandidate(activeSchoolIdForMap, pin.raw, false, true);
        }
    };

    const modal = (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
            <div className={`bg-white rounded-2xl shadow-2xl w-full flex overflow-hidden transition-all duration-500 ease-in-out ${isMapVisible ? 'w-[95vw] max-w-[1400px]' : 'max-w-3xl'}`} style={{ maxHeight: '90vh' }}>
                
                {/* Left Column: List */}
                <div className={`flex flex-col transition-all duration-500 ${isMapVisible ? 'w-full lg:w-[500px] xl:w-[600px] flex-shrink-0 border-r border-gray-200' : 'w-full'}`} style={{ maxHeight: '90vh' }}>
                    
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
                    <div className="overflow-y-auto flex-1 p-5 space-y-4">
                        {matchList.map(({ school, candidates }) => {
                            const sel = selections[school.id];
                            const isKeep = sel === 'keep';
                            const activeAct = activeActions[school.id];
                            const isTie = sel && sel.needsConfirmation;
                            const isResolved = sel !== undefined && !isTie;

                            return (
                                <div
                                    key={school.id}
                                    className={`rounded-xl border p-4 transition-colors ${
                                        isKeep
                                            ? 'border-amber-200 bg-amber-50/40'
                                            : isTie
                                            ? 'border-orange-200 bg-orange-50/30'
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
                                            {isResolved && !isKeep && (
                                                <CheckCircle className="w-4 h-4 text-blue-500 ml-auto flex-shrink-0" />
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
                                            {!isResolved && !isTie && !isKeep && (
                                                <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-100 px-2 py-0.5 rounded-full">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    Da controllare
                                                </span>
                                            )}
                                            
                                            <button
                                                onClick={() => handleShowMap(school.id)}
                                                className={`p-1.5 ml-2 rounded-lg border transition-colors shadow-sm flex-shrink-0 ${
                                                    activeAct === 'map' || (activeAct && activeSchoolIdForMap === school.id && !mapHidden)
                                                    ? 'bg-blue-600 text-white border-blue-600 shadow-blue-200'
                                                    : 'bg-white text-gray-500 border-gray-200 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200'
                                                }`}
                                                title="Mostra mappa per questa fermata"
                                            >
                                                <MapPin className="w-4 h-4" />
                                            </button>
                                        </div>
                                        <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                            <MapPin className="w-3 h-3 flex-shrink-0" />
                                            Indirizzo file: <span className="font-mono ml-1">{school.address}</span>
                                        </div>
                                    </div>

                                    {/* DB Candidates */}
                                    {candidates.length > 0 && (
                                        <div className="space-y-2 mb-3">
                                            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Corrispondenze DB:</div>
                                            {candidates.map((candidate, idx) => {
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
                                                <div className="text-sm text-gray-500 text-center py-2">Nessun suggerimento trovato.</div>
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
                                    {!isResolved && !isKeep && (
                                        <button
                                            onClick={() => markKeep(school.id)}
                                            className="w-full mt-2 text-center text-xs font-medium text-gray-500 hover:text-gray-700 py-1 transition-colors"
                                        >
                                            Nessuno di questi, mantieni indirizzo originale
                                        </button>
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

                {/* Right Column: Map */}
                <div className={`bg-gray-100 transition-all duration-500 relative ${isMapVisible ? 'flex-1 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`} style={{ maxHeight: '90vh' }}>
                    {mapReady && (
                        <>
                            <MapContainer 
                                center={mapCenter} 
                                zoom={13} 
                                style={{ height: '100%', width: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                                zoomControl={false}
                            >
                                <TileLayer
                                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                />
                                <MapController pins={mapPins} />
                                {mapPins.map(pin => (
                                    <Marker 
                                        key={pin.id} 
                                        position={[pin.lat, pin.lon]}
                                        icon={createIcon(pin.isSelected)}
                                        eventHandlers={{ click: () => handleMapPinClick(pin) }}
                                        zIndexOffset={pin.isSelected ? 1000 : 0}
                                    >
                                        <Popup>
                                            <div className="text-sm font-semibold text-gray-900">{pin.title}</div>
                                            <div className="text-xs text-gray-600 mt-1">{pin.desc}</div>
                                        </Popup>
                                    </Marker>
                                ))}
                            </MapContainer>
                    
                            {/* Floating Map Label and Close Button */}
                            <div className="absolute top-4 left-4 z-[400] flex gap-2">
                                <div className="bg-white/90 backdrop-blur-sm shadow-sm border border-gray-200 rounded-lg px-3 py-2 text-xs font-medium text-gray-700 flex items-center gap-2">
                                    <MapPin className="w-4 h-4 text-blue-500" />
                                    Anteprima Posizione
                                </div>
                            </div>
                            <button 
                                onClick={() => setMapHidden(true)}
                                className="absolute top-4 right-4 z-[400] bg-white hover:bg-gray-100 text-gray-600 rounded-lg p-2 shadow-sm border border-gray-200 transition-colors"
                                title="Chiudi mappa"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            {/* AI Empty State Overlay */}
                            {Object.entries(activeActions).some(([sId, act]) => act === 'ai' && !loadingAi[sId] && (aiSuggestions[sId] || []).length === 0) && (
                                <div className="absolute inset-0 z-[500] bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center animate-in fade-in">
                                    <AlertTriangle className="w-12 h-12 text-amber-500 mb-4" />
                                    <h3 className="text-xl font-bold text-gray-900 mb-2">Nessuna soluzione trovata dall'AI!</h3>
                                    <p className="text-sm text-gray-600 max-w-md mb-6">
                                        Prova ad inserire l'indirizzo manualmente o utilizza le coordinate GPS (latitudine, longitudine).
                                    </p>
                                    <button 
                                        onClick={() => {
                                            const schoolId = Object.keys(activeActions).find(id => activeActions[id] === 'ai');
                                            if (schoolId) handleActionToggle(schoolId, 'manual', null);
                                        }}
                                        className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded-lg shadow-sm mb-6 transition-colors"
                                    >
                                        Inserisci a mano
                                    </button>
                                    
                                    <div className="w-full max-w-lg bg-gray-900 rounded-xl overflow-hidden shadow-xl border border-gray-200">
                                        <div className="bg-gray-800 px-4 py-2 text-xs font-medium text-gray-300 border-b border-gray-700 flex items-center gap-2">
                                            <span>💡</span> Tutorial: Come ottenere le coordinate da Google Maps
                                        </div>
                                        <video 
                                            src="/assets/tutorial_copy_coordinates.mov" 
                                            controls 
                                            className="w-full aspect-video outline-none"
                                        />
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>

            </div>
        </div>
    );

    return createPortal(modal, document.body);
};

export default DBMatchModal;
