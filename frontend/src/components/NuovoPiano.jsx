import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { Search, PlusCircle, X, CheckCircle, ChevronDown, ChevronUp, Database, Construction } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';

function NuovoPiano({ db, onSchoolsReady }) {
    // --- Left panel state ---
    const [allInstitutes, setAllInstitutes] = useState([]);
    const [dbLoading, setDbLoading] = useState(false);
    const [dbError, setDbError] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');

    // --- Right panel state ---
    const [selectedSchools, setSelectedSchools] = useState([]);

    // --- Manual add state ---
    const [manualOpen, setManualOpen] = useState(false);
    const [manualName, setManualName] = useState('');
    const [manualAddress, setManualAddress] = useState('');
    const [manualLat, setManualLat] = useState(null);
    const [manualLon, setManualLon] = useState(null);
    const [manualDemand, setManualDemand] = useState(1);

    // Load institutes from Firestore on mount
    useEffect(() => {
        if (!db) return;
        let cancelled = false;
        setDbLoading(true);
        setDbError(null);
        getDocs(collection(db, 'institutes'))
            .then((snapshot) => {
                if (cancelled) return;
                const docs = snapshot.docs.map(d => ({ ...d.data() }));
                setAllInstitutes(docs.filter(d => d.lat && d.lon && d.address));
                setDbError(null);
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('Firestore fetch error:', err);
                setDbError('Errore nel caricamento del database.');
            })
            .finally(() => {
                if (!cancelled) setDbLoading(false);
            });
        return () => { cancelled = true; };
    }, [db]);

    // Tokenized search filter
    const filteredInstitutes = useMemo(() => {
        if (!searchQuery.trim()) return allInstitutes.slice(0, 50);
        const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        return allInstitutes
            .filter((inst) =>
                tokens.every(
                    (t) =>
                        inst.name.toLowerCase().includes(t) ||
                        inst.address.toLowerCase().includes(t)
                )
            )
            .slice(0, 50);
    }, [searchQuery, allInstitutes]);

    // Check if an institute is already selected (by name + address)
    const isSelected = (inst) =>
        selectedSchools.some(
            (s) => s.name === inst.name && s.address === inst.address
        );

    // Add from DB
    const handleAdd = (inst) => {
        if (isSelected(inst)) return;
        setSelectedSchools((prev) => [
            ...prev,
            {
                _key: `${inst.name}__${inst.address}`,
                name: inst.name,
                address: inst.address,
                lat: inst.lat,
                lon: inst.lon,
                demand: 1,
                institute: inst.institute || null,
            },
        ]);
    };

    // Update demand for a selected school
    const handleDemandChange = (key, value) => {
        setSelectedSchools((prev) =>
            prev.map((s) =>
                s._key === key
                    ? { ...s, demand: Math.max(1, parseInt(value) || 1) }
                    : s
            )
        );
    };

    // Remove a selected school
    const handleRemove = (key) => {
        setSelectedSchools((prev) => prev.filter((s) => s._key !== key));
    };

    // Manual add
    const handleManualAdd = () => {
        if (!manualName.trim() || !manualAddress.trim()) return;
        const key = `manual__${manualName}__${manualAddress}__${Date.now()}`;
        setSelectedSchools((prev) => [
            ...prev,
            {
                _key: key,
                name: manualName.trim(),
                address: manualAddress.trim(),
                lat: manualLat ?? 0,
                lon: manualLon ?? 0,
                demand: Math.max(1, manualDemand),
            },
        ]);
        setManualName('');
        setManualAddress('');
        setManualLat(null);
        setManualLon(null);
        setManualDemand(1);
    };

    // Confirm list
    const handleConfirm = () => {
        if (selectedSchools.length === 0) return;
        const schools = selectedSchools.map((s, idx) => ({
            id: idx,
            name: s.name,
            address: s.address,
            lat: s.lat,
            lon: s.lon,
            demand: s.demand,
            institute: s.institute || null,
        }));
        onSchoolsReady(schools);
    };

    const allValid =
        selectedSchools.length > 0 && selectedSchools.every((s) => s.demand >= 1);

    return (
        <div className="flex flex-col gap-4 w-full animate-fade-in">
            {/* Under-construction chip */}
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium px-4 py-2 rounded-full w-fit mb-4">
                <Construction className="w-4 h-4 flex-shrink-0" />
                <span>Funzionalità in costruzione — puoi già provarla!</span>
            </div>

            {/* Two-column panel */}
            <div className="flex gap-4 w-full">
                {/* ── Left panel: search ── */}
                <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
                    <div className="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 className="font-semibold text-gray-800 text-base flex items-center gap-2">
                            <Database className="w-4 h-4 text-blue-500" />
                            Cerca nel Database
                        </h3>
                    </div>

                    <div className="p-3 border-b border-gray-100">
                        <div className="relative">
                            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
                            <input
                                type="text"
                                placeholder="Cerca scuola, indirizzo o comune..."
                                className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                disabled={!db || dbLoading}
                            />
                        </div>
                        {!dbLoading && !dbError && db && (
                            <p className="text-xs text-gray-400 mt-1.5 pl-1">
                                {searchQuery.trim()
                                    ? `${filteredInstitutes.length} risultati`
                                    : `${allInstitutes.length} istituti nel database`}
                            </p>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '380px' }}>
                        {/* Null DB */}
                        {!db && (
                            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                                <Database className="w-8 h-8 text-gray-300 mb-3" />
                                <p className="text-sm text-gray-400 italic">
                                    Database non disponibile. Verifica la connessione Firebase.
                                </p>
                            </div>
                        )}

                        {/* Loading */}
                        {db && dbLoading && (
                            <div className="flex items-center justify-center py-12 text-sm text-gray-400 italic">
                                Caricamento database...
                            </div>
                        )}

                        {/* Error */}
                        {db && !dbLoading && dbError && (
                            <div className="flex items-center justify-center py-12 text-sm text-red-400 italic px-4 text-center">
                                {dbError}
                            </div>
                        )}

                        {/* Empty results */}
                        {db && !dbLoading && !dbError && filteredInstitutes.length === 0 && searchQuery.trim() && (
                            <div className="flex items-center justify-center py-12 text-sm text-gray-400 italic px-4 text-center">
                                Nessun risultato per «{searchQuery}»
                            </div>
                        )}

                        {/* Empty state (no query) */}
                        {db && !dbLoading && !dbError && allInstitutes.length === 0 && !searchQuery.trim() && (
                            <div className="flex items-center justify-center py-12 text-sm text-gray-400 italic px-4 text-center">
                                Nessun istituto trovato nel database.
                            </div>
                        )}

                        {/* Results */}
                        {db && !dbLoading && !dbError && filteredInstitutes.length > 0 &&
                            filteredInstitutes.map((inst) => {
                                const added = isSelected(inst);
                                return (
                                    <div
                                        key={`${inst.name}__${inst.address}`}
                                        className="flex items-center justify-between px-4 py-3 border-b border-gray-50 hover:bg-blue-50/50 transition-colors gap-3"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="font-medium text-gray-800 text-sm truncate">
                                                {inst.name}
                                            </div>
                                            <div className="text-xs text-gray-400 truncate mt-0.5">
                                                {inst.address}
                                            </div>
                                        </div>
                                        {added ? (
                                            <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2.5 py-1.5 rounded-lg flex-shrink-0">
                                                <CheckCircle className="w-3.5 h-3.5" />
                                                Aggiunto ✓
                                            </span>
                                        ) : (
                                            <button
                                                onClick={() => handleAdd(inst)}
                                                className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0"
                                            >
                                                <PlusCircle className="w-3.5 h-3.5" />
                                                Aggiungi
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        }
                    </div>
                </div>

                {/* ── Right panel: selected schools ── */}
                <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
                    <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                        <h3 className="font-semibold text-gray-800 text-base">
                            Fermate selezionate
                        </h3>
                        <span className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full">
                            {selectedSchools.length}
                        </span>
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '380px' }}>
                        {selectedSchools.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 px-6 text-center text-sm text-gray-400 italic">
                                <p>Nessuna fermata selezionata.</p>
                                <p className="mt-1">Cerca e aggiungi scuole dal database.</p>
                            </div>
                        ) : (
                            selectedSchools.map((school) => (
                                <div
                                    key={school._key}
                                    className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50/80 transition-colors group"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium text-gray-800 text-sm truncate">
                                            {school.name}
                                        </div>
                                        <div className="text-xs text-gray-400 truncate mt-0.5">
                                            {school.address}
                                        </div>
                                    </div>
                                    <input
                                        type="number"
                                        className="w-16 text-center text-sm border border-gray-200 rounded-lg py-1 px-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                                        value={school.demand}
                                        min={1}
                                        onChange={(e) =>
                                            handleDemandChange(school._key, e.target.value)
                                        }
                                        title="Partecipanti"
                                    />
                                    <button
                                        onClick={() => handleRemove(school._key)}
                                        className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
                                        title="Rimuovi fermata"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ))
                        )}

                        {/* Manual add section */}
                        <div className="border-t border-gray-100 mt-1">
                            <button
                                onClick={() => setManualOpen((v) => !v)}
                                className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                                <span className="font-medium">
                                    Aggiungi fermata non presente nel database
                                </span>
                                {manualOpen ? (
                                    <ChevronUp className="w-4 h-4" />
                                ) : (
                                    <ChevronDown className="w-4 h-4" />
                                )}
                            </button>

                            {manualOpen && (
                                <div className="px-4 pb-4 flex flex-col gap-3">
                                    <input
                                        type="text"
                                        placeholder="Nome fermata"
                                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                        value={manualName}
                                        onChange={(e) => setManualName(e.target.value)}
                                    />
                                    <AddressAutocomplete
                                        value={manualAddress}
                                        onChange={setManualAddress}
                                        onSelect={(data) => {
                                            setManualAddress(data.address);
                                            setManualLat(data.lat);
                                            setManualLon(data.lon);
                                        }}
                                        placeholder="Indirizzo"
                                    />
                                    {manualAddress && manualLat === null && (
                                        <p className="text-xs text-amber-600 mt-1">Seleziona un indirizzo dal menu a discesa per ottenere le coordinate.</p>
                                    )}
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs text-gray-500 flex-shrink-0">
                                            Partecipanti
                                        </label>
                                        <input
                                            type="number"
                                            className="w-20 text-center text-sm border border-gray-200 rounded-lg py-2 px-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                                            value={manualDemand}
                                            min={1}
                                            onChange={(e) =>
                                                setManualDemand(Math.max(1, parseInt(e.target.value) || 1))
                                            }
                                        />
                                        <button
                                            onClick={handleManualAdd}
                                            disabled={!manualName.trim() || !manualAddress.trim() || manualLat === null}
                                            className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed px-3 py-2 rounded-lg transition-colors"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Aggiungi
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex justify-center">
                <button
                    onClick={handleConfirm}
                    disabled={!allValid}
                    title={
                        selectedSchools.length === 0
                            ? 'Seleziona almeno una fermata per continuare'
                            : undefined
                    }
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-bold px-10 py-3 rounded-xl shadow-lg shadow-blue-200 disabled:shadow-none transition-all transform hover:-translate-y-0.5 disabled:transform-none flex items-center gap-2"
                >
                    <CheckCircle className="w-5 h-5" />
                    Conferma Lista ({selectedSchools.length}{' '}
                    {selectedSchools.length === 1 ? 'fermata' : 'fermate'})
                </button>
            </div>
        </div>
    );
}

export default NuovoPiano;
