import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Menu, FileSpreadsheet, Database } from 'lucide-react';
import { collection, query, orderBy, limit, onSnapshot, addDoc, deleteDoc, doc, updateDoc, serverTimestamp, getDocs, setDoc } from 'firebase/firestore';
import { initFirebase } from './firebase';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';
import AddressCorrectionBanner from './components/AddressCorrectionBanner';
import GeocodingFailuresModal from './components/GeocodingFailuresModal';
import DBMatchModal from './components/DBMatchModal';
import { buildMatchList } from './utils/matchInstitutes';
import TripSidebar from './components/TripSidebar';
import ResumeWorkBanner from './components/ResumeWorkBanner';
import FixtureTool from './components/FixtureTool';
import InstituteList from './components/InstituteList';
import NuovoPiano from './components/NuovoPiano';
import ValidationPreview from './components/ValidationPreview';
import { getInstituteColorMap } from './utils/colors';
import API_BASE_URL from './config';

const formatDuration = (seconds) => {
    if (seconds <= 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
};

const makeStableId = (name, address) =>
    btoa(unescape(encodeURIComponent(`${name}||${address}`))).replace(/[/+=]/g, '_');

// ~2.5s/address: adjusted from 5s after user feedback (actual ~52s for 22 addresses)
const AI_SECONDS_PER_ADDRESS = 2.5;

// Simple Loading Overlay Component
const LoadingOverlay = ({ progress, message }) => {
    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999] flex flex-col items-center justify-center animate-fade-in">
            <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 max-w-sm w-full mx-4">
                <div className="relative w-16 h-16">
                    <div className="absolute inset-0 border-4 border-blue-100 rounded-full"></div>
                    <div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div>
                </div>
                <div className="text-center w-full">
                    <h3 className="text-lg font-bold text-gray-800 flex items-center justify-center gap-2">
                        Elaborazione in corso...
                    </h3>
                    <p className="text-sm text-gray-500 mt-1 mb-3">{message || 'Preparazione dati...'}</p>

                    {/* Progress Bar */}
                    <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        <div
                            className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${Math.max(5, progress || 0)}%` }}
                        />
                    </div>
                    <p className="text-xs text-gray-400 mt-1 text-right">{progress || 0}%</p>
                </div>
            </div>
        </div>
    );
};

function App() {
    const [schools, setSchools] = useState([]);
    const [activeTab, setActiveTab] = useState('app'); // 'app' | 'institutes'
    const [inputMode, setInputMode] = useState('excel'); // 'excel' | 'database'
    const [message, setMessage] = useState('');
    const [showDetails, setShowDetails] = useState(false);
    const [openEditorTrigger, setOpenEditorTrigger] = useState(0);
    const [resetKey, setResetKey] = useState(0);
    const [loadingState, setLoadingState] = useState({ active: false, progress: 0, message: '', totalAddresses: 0, aiExtraSeconds: 0, isAiPhase: false }); // Global loading state
    const [correctionInfo, setCorrectionInfo] = useState(null); // { corrections, correctedFile, unresolvedByAI }
    const [geocodingFailures, setGeocodingFailures] = useState(null); // schools with geocoding_failed:true
    const [version, setVersion] = useState('');
    // null = not yet fetched (Map must not render until this is set)
    const [mapsKey, setMapsKey] = useState(null);

    // Trip history (Firestore)
    const [db, setDb] = useState(null);
    const [trips, setTrips] = useState([]);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [tripToRestore, setTripToRestore] = useState(null);
    const [currentTripId, setCurrentTripId] = useState(null);
    const [resumeDismissed, setResumeDismissed] = useState(false);
    const [allDbInstitutes, setAllDbInstitutes] = useState([]);
    const [dbMatchList, setDbMatchList] = useState(null); // null = not showing
    const [pendingRaw, setPendingRaw] = useState(null); // { rawSchools, taskId, matchList }
    const [validationPending, setValidationPending] = useState(null); // { schools, errors, taskId }

    const handleRawSchoolsReady = ({ rawSchools, taskId }) => {
        const matches = allDbInstitutes.length > 0 ? buildMatchList(rawSchools, allDbInstitutes) : [];
        
        const autoResolved = {};
        const matchesToShow = [];

        matches.forEach(({ school, candidates }) => {
            const perfect = candidates.find(c => c._isPerfect);
            if (perfect) {
                autoResolved[school.id] = {
                    lat: perfect.lat,
                    lon: perfect.lon,
                    address: perfect.address,
                    name: perfect.name
                };
            } else {
                matchesToShow.push({ school, candidates });
            }
        });

        setPendingRaw({ rawSchools, taskId, matchList: matchesToShow, autoResolved });
        if (matchesToShow.length > 0) {
            setDbMatchList(matchesToShow);
        } else {
            continueProcessing(taskId, autoResolved);
        }
    };

    useEffect(() => {
        fetch('/version.txt')
            .then(res => res.text())
            .then(text => setVersion(text.trim()))
            .catch(err => console.error('Error fetching version:', err));
        fetch(`${API_BASE_URL}/api/config`)
            .then(r => r.json())
            .then(d => {
                setMapsKey('');
                if (d.firebase?.projectId) {
                    setDb(initFirebase(d.firebase));
                }
            })
            .catch(err => {
                console.error('Error fetching config:', err);
                setMapsKey('');
            });
    }, []);

    // Subscribe to Firestore trip history once db is ready
    useEffect(() => {
        if (!db) return;
        const q = query(collection(db, 'trips'), orderBy('savedAt', 'desc'), limit(50));
        const unsub = onSnapshot(q, snap => {
            setTrips(snap.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    results: typeof data.results === 'string' ? JSON.parse(data.results) : data.results,
                };
            }));
        }, err => {
            console.warn('Firestore unavailable:', err.message);
        });
        return unsub;
    }, [db]);

    // Load Firebase institutes and keep synced
    useEffect(() => {
        if (!db) return;
        const unsub = onSnapshot(collection(db, 'institutes'), snap => {
            setAllDbInstitutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }, err => console.warn('Failed to sync institutes:', err));
        return unsub;
    }, [db]);

    const handleTripSaved = async (tripData) => {
        if (!db) return null;
        try {
            // eslint-disable-next-line no-unused-vars
            const { savedAt, ...fields } = tripData;
            const payload = {
                ...fields,
                results: typeof fields.results === 'object' ? JSON.stringify(fields.results) : fields.results,
                stage: 'optimized',
                updatedAt: serverTimestamp(),
            };
            if (currentTripId) {
                await updateDoc(doc(db, 'trips', currentTripId), payload);
                return currentTripId;
            } else {
                const docRef = await addDoc(collection(db, 'trips'), { ...payload, savedAt: serverTimestamp() });
                setCurrentTripId(docRef.id);
                return docRef.id;
            }
        } catch (err) {
            console.warn('Failed to save trip:', err.message);
            return null;
        }
    };

    const handleTripUpdated = async (tripId, fields) => {
        if (!db || !tripId) return;
        try {
            const payload = { ...fields, updatedAt: serverTimestamp() };
            if (payload.results && typeof payload.results === 'object') {
                payload.results = JSON.stringify(payload.results);
            }
            await updateDoc(doc(db, 'trips', tripId), payload);
        } catch (err) {
            console.warn('Failed to update trip:', err.message);
        }
    };

    const handleTripRenamed = async (tripId, newName) => {
        if (!db) return;
        try {
            await updateDoc(doc(db, 'trips', tripId), { label: newName });
        } catch (err) {
            console.warn('Failed to rename trip:', err.message);
        }
    };

    const handleUploadComplete = async ({ schools: data, correctedFile, addressCorrections, correctionStatus, unresolvedByAI }) => {
        setSchools(data);
        setResumeDismissed(true);
        setMessage('File caricato con successo! Procedi alla configurazione.');
        setCorrectionInfo({
            corrections: addressCorrections ?? [],
            correctedFile,
            status: correctionStatus,
            unresolvedByAI: unresolvedByAI ?? [],
        });
        const failed = data.filter(s => s.geocoding_failed);
        if (failed.length > 0) setGeocodingFailures(failed);
        if (db) {
            try {
                const totalPax = data.reduce((s, sc) => s + (parseInt(sc.demand) || 0), 0);
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const label = data.length > 0
                    ? `${data.length} fermate, ${totalPax} passeggeri - ${dateStr}`
                    : `Nuovo lavoro - ${dateStr}`;
                if (currentTripId) {
                    await updateDoc(doc(db, 'trips', currentTripId), {
                        label, stage: 'uploaded', schools: data,
                        destination: '', destCoords: null,
                        updatedAt: serverTimestamp(),
                    });
                } else {
                    const docRef = await addDoc(collection(db, 'trips'), {
                        label, stage: 'uploaded', schools: data, destination: '', destCoords: null,
                        capacity: 56, startTime: '08:00', timeMode: 'arrival', results: null,
                        savedAt: serverTimestamp(), updatedAt: serverTimestamp(),
                    });
                    setCurrentTripId(docRef.id);
                }
            } catch (err) { console.warn('Failed to create/update trip:', err.message); }
        }
    };

    const continueProcessing = async (taskId, resolutions, endpoint = '/api/continue-processing', body = null) => {
        setLoadingState({ active: true, progress: 20, message: 'Correzione indirizzi con AI...', totalAddresses: 0, aiExtraSeconds: 0, isAiPhase: true });
        try {
            const requestBody = body ?? { task_id: taskId, resolutions };
            const resp = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            const respData = await resp.json();
            const pollId = respData.task_id;

            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/api/status/${pollId}`);
                    const statusData = await statusRes.json();
                    const { status, result, progress, message } = statusData;
                    setLoadingState(prev => ({
                        ...prev,
                        progress: progress || 0,
                        message: message || '',
                        totalAddresses: statusData.total_addresses || 0,
                        aiExtraSeconds: statusData.ai_extra_seconds || 0,
                        isAiPhase: statusData.is_ai_phase || false,
                    }));
                    if (status === 'completed') {
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 100, message: 'Completato' });
                        await handleUploadComplete({
                            schools: result,
                            correctedFile: statusData.corrected_file,
                            addressCorrections: statusData.address_corrections ?? [],
                            correctionStatus: statusData.correction_status,
                            unresolvedByAI: statusData.unresolved_by_ai ?? [],
                        });
                    } else if (status === 'error') {
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 0, message: '' });
                    }
                } catch (e) { console.error('Polling error', e); }
            }, 1000);
        } catch (e) {
            console.error('continueProcessing error', e);
            setLoadingState({ active: false, progress: 0, message: '' });
        }
    };

    const handleTripRestore = (trip) => {
        setSidebarOpen(false);
        if (trip.stage === 'db_match_pending') {
            // Re-open the DB match modal with saved partial resolutions
            const matchList = trip.dbMatchList || [];
            setPendingRaw({ rawSchools: trip.schools, taskId: null, matchList });
            setCurrentTripId(trip.id);
            setDbMatchList(matchList.length > 0 ? matchList : null);
            if (matchList.length === 0) {
                // No candidates: just continue processing with partial resolutions
                continueProcessing(null, trip.partialResolutions || {}, '/api/start-processing', {
                    raw_schools: trip.schools,
                    resolutions: trip.partialResolutions || {},
                });
            }
            return;
        }
        const restored = {
            ...trip,
            results: typeof trip.results === 'string' ? JSON.parse(trip.results) : trip.results,
        };
        setSchools(restored.schools);
        setTripToRestore(restored);
        setCurrentTripId(trip.id);
    };

    const handleTripDelete = async (tripId) => {
        if (!db) return;
        try {
            await deleteDoc(doc(db, 'trips', tripId));
            if (currentTripId === tripId) {
                handleReset();
            }
        } catch (err) {
            console.warn('Failed to delete trip:', err.message);
        }
    };

    const handleReset = () => {
        setSchools([]);
        setMessage('');
        setShowDetails(false);
        setCorrectionInfo(null);
        setGeocodingFailures(null);
        setCurrentTripId(null);
        setTripToRestore(null);
        setPendingRaw(null);
        setValidationPending(null);
        setDbMatchList(null);
        setResumeDismissed(false);
        setInputMode('excel');
        setResetKey(prev => prev + 1); // Force FileUpload to remount and clear input
    };

    // Called when user resolves failed addresses in the modal
    const handleGeocodingResolved = (corrections) => {
        // corrections: { [id]: { lat, lon } }
        setSchools(prev => prev.map(s => {
            const fix = corrections[s.id];
            if (!fix) return s;
            return { ...s, lat: parseFloat(fix.lat), lon: parseFloat(fix.lon), geocoding_failed: false };
        }));
        setGeocodingFailures(null);
    };

    const handleDbMatchResolved = async (resolutions) => {
        setDbMatchList(null);
        if (pendingRaw) {
            const { taskId, rawSchools, autoResolved } = pendingRaw;
            setPendingRaw(null);
            
            const finalResolutions = { ...(autoResolved || {}), ...(resolutions || {}) };
            
            // Filter out discarded schools
            const discardedIds = new Set(
                Object.entries(finalResolutions)
                    .filter(([, res]) => res && res.discard)
                    .map(([id]) => id)
            );
            const filteredRawSchools = rawSchools.filter(s => !discardedIds.has(String(s.id)));
            
            // Save manual/AI resolutions to Firestore if requested
            if (db) {
                const writes = [];
                Object.entries(resolutions || {}).forEach(([schoolId, res]) => {
                    if (res && res !== 'keep' && !res.discard && res.saveToDb) {
                        const original = rawSchools.find(s => String(s.id) === String(schoolId));
                        if (original) {
                            const name = original.name.replace(/\(.*?\)/g, '').replace(/["']/g, '').trim();
                            let desc = '';
                            if (original.name.includes('(')) {
                                const m = original.name.match(/\((.*?)\)/);
                                if (m) desc = m[1].replace(/["']/g, '').trim();
                            }
                            
                            const stableId = makeStableId(original.name, res.address);
                            const type = /(ic\b|istituto|scuola|liceo|polo|primaria|secondaria)/i.test(name) ? 'istituto' : 'destinazione';
                            
                            writes.push(setDoc(doc(db, 'institutes', stableId), {
                                name: name,
                                description: desc,
                                originalName: original.name,
                                address: res.address,
                                lat: res.lat,
                                lon: res.lon,
                                type: type,
                                updatedAt: serverTimestamp(),
                            }, { merge: true }));
                        }
                    }
                });
                
                if (writes.length > 0) {
                    Promise.all(writes).catch(err => console.error("Error saving to Firestore:", err));
                }
            }
            
            if (taskId) {
                await continueProcessing(taskId, finalResolutions);
            } else {
                // Resume from Firestore: no backend task, use start-processing
                await continueProcessing(null, finalResolutions, '/api/start-processing', { raw_schools: filteredRawSchools, resolutions: finalResolutions });
            }
        }
    };

    const handleDbMatchEscape = async (partialSelections) => {
        setDbMatchList(null);
        if (!pendingRaw || !db) {
            setPendingRaw(null);
            return;
        }
        const { rawSchools, matchList } = pendingRaw;
        setPendingRaw(null);
        
        // Filter out discarded schools from rawSchools and matchList
        const filteredSchools = rawSchools.filter(s => {
            const res = partialSelections && partialSelections[s.id];
            return !(res && res.discard);
        });
        const filteredMatchList = (matchList || []).filter(({ school }) => {
            const res = partialSelections && partialSelections[school.id];
            return !(res && res.discard);
        });

        try {
            const totalPax = filteredSchools.reduce((s, sc) => s + (parseInt(sc.demand) || 0), 0);
            const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const label = `${filteredSchools.length} fermate, ${totalPax} passeggeri - ${dateStr} (in verifica)`;
            await addDoc(collection(db, 'trips'), {
                label,
                stage: 'db_match_pending',
                schools: filteredSchools,
                dbMatchList: filteredMatchList.map(({ school, candidates }) => ({ school, candidates })),
                partialResolutions: partialSelections,
                destination: '', destCoords: null, capacity: 56, startTime: '08:00',
                timeMode: 'arrival', results: null,
                savedAt: serverTimestamp(), updatedAt: serverTimestamp(),
            });
        } catch (err) { console.warn('Failed to save pending trip:', err.message); }
    };

    const handleManualAddressCorrect = async (schoolName, newAddress) => {
        const resp = await fetch(`${API_BASE_URL}/api/geocode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: newAddress }),
        });
        const { lat, lon } = await resp.json();
        setSchools(prev => prev.map(s =>
            s.name === schoolName ? { ...s, address: newAddress, lat: parseFloat(lat), lon: parseFloat(lon), geocoding_failed: false } : s
        ));
    };

    const handleSchoolsFromDB = async (schoolsFromDB) => {
        setSchools(schoolsFromDB);
        setResumeDismissed(true);
        setMessage('Lista fermate caricata dal database!');
        setCorrectionInfo(null);
        setGeocodingFailures(null);
        setInputMode('excel');
        // Create Firestore trip doc (same as onUploadSuccess does)
        if (db) {
            try {
                const totalPax = schoolsFromDB.reduce((s, sc) => s + (parseInt(sc.demand) || 0), 0);
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const label = `${schoolsFromDB.length} fermate, ${totalPax} passeggeri - ${dateStr}`;
                const docRef = await addDoc(collection(db, 'trips'), {
                    label,
                    stage: 'uploaded',
                    schools: schoolsFromDB,
                    destination: '',
                    destCoords: null,
                    capacity: 56,
                    startTime: '08:00',
                    timeMode: 'arrival',
                    results: null,
                    savedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
                setCurrentTripId(docRef.id);
            } catch (err) {
                console.warn('Failed to create trip on DB import:', err.message);
            }
        }
    };

    // Auto-scroll refs
    const dashboardRef = useRef(null);
    const uploadRef = useRef(null);

    // Scroll to dashboard when schools are loaded
    useEffect(() => {
        if (schools.length > 0 && dashboardRef.current) {
            setTimeout(() => {
                dashboardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }, [schools]);

    // Stable Color Mapping
    // We maintain a list of all unique institutes encountered to ensure colors don't shift
    // and new ones get new colors.
    const [knownInstitutes, setKnownInstitutes] = useState([]);

    useEffect(() => {
        if (schools.length > 0) {
            const currentInstitutes = schools.map(s => s.institute).filter(Boolean);
            setKnownInstitutes(prev => {
                const newSet = new Set(prev);
                let changed = false;
                currentInstitutes.forEach(inst => {
                    if (!newSet.has(inst)) {
                        newSet.add(inst);
                        changed = true;
                    }
                });
                return changed ? Array.from(newSet) : prev;
            });
        }
    }, [schools]);

    // Generate color map from the stable list
    const instituteColorMap = React.useMemo(() => {
        return getInstituteColorMap(knownInstitutes);
    }, [knownInstitutes]);

    return (
        <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
            <TripSidebar
                open={sidebarOpen}
                trips={trips}
                onRestore={handleTripRestore}
                onDelete={handleTripDelete}
                onClose={() => setSidebarOpen(false)}
            />
            {loadingState.active && <LoadingOverlay progress={loadingState.progress} message={loadingState.message} />}
            {geocodingFailures && (
                <GeocodingFailuresModal
                    failures={geocodingFailures}
                    onResolve={handleGeocodingResolved}
                />
            )}
            {dbMatchList && (
                <DBMatchModal
                    matchList={dbMatchList}
                    onResolved={handleDbMatchResolved}
                    onClose={(partialSelections) => handleDbMatchEscape(partialSelections)}
                />
            )}

            {/* Header */}
            <header className="bg-white shadow">
                <div className="w-full max-w-[95%] 3xl:max-w-[2400px] 4xl:max-w-[3200px] mx-auto py-6 px-4 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setSidebarOpen(prev => !prev)}
                            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
                            title="Storico viaggi"
                        >
                            <Menu className="w-5 h-5 text-gray-600" />
                        </button>
                        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
                            <img src="/favicon.svg" alt="BusPlan Logo" className="w-8 h-8 md:w-10 md:h-10 text-blue-600" />
                            BusPlan
                            <span className="text-sm font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded-md">Beta</span>
                        </h1>
                    </div>
                    {schools.length > 0 && (
                        <button
                            onClick={handleReset}
                            className="bg-red-50 text-red-600 hover:bg-red-100 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        >
                            🔄 Reset / Nuovo Progetto
                        </button>
                    )}
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 min-h-0 overflow-y-auto w-full max-w-[95%] 3xl:max-w-[2400px] 4xl:max-w-[3200px] mx-auto px-4 py-4 flex flex-col">
                {/* Tab bar */}
                <div className="flex gap-2 mb-6 border-b border-gray-200">
                    <button
                        onClick={() => setActiveTab('app')}
                        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            activeTab === 'app'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                    >
                        Pianificazione
                    </button>
                    <button
                        onClick={() => setActiveTab('institutes')}
                        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            activeTab === 'institutes'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                    >
                        Database
                    </button>
                </div>

                {activeTab === 'institutes' && (
                    <section className="flex-1 min-h-0 bg-white p-6 rounded-lg shadow-sm border border-gray-100 flex flex-col overflow-hidden">
                        <h2 className="text-xl font-semibold mb-4 text-gray-800 flex-shrink-0">Database</h2>
                        <div className="flex-1 min-h-0 overflow-hidden">
                            <InstituteList db={db} />
                        </div>
                    </section>
                )}



                {activeTab === 'app' && <div className="space-y-8">
                    {/* Section 1: Upload */}
                    <section ref={uploadRef} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                        <h2 className="text-xl font-semibold mb-4 text-gray-800">1. Importazione Dati</h2>
                        {schools.length === 0 && trips.length > 0 && !resumeDismissed && db && (
                            <ResumeWorkBanner
                                trip={trips[0]}
                                onRestore={handleTripRestore}
                                onDismiss={() => setResumeDismissed(true)}
                            />
                        )}

                        {/* Input mode toggle */}
                        {schools.length === 0 && (
                        <div className="flex gap-2 mb-4">
                            <button
                                onClick={() => setInputMode('excel')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                                    inputMode === 'excel'
                                        ? 'bg-blue-600 text-white border-blue-600'
                                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                }`}
                            >
                                <FileSpreadsheet className="w-4 h-4" /> Carica Excel
                            </button>
                            <button
                                onClick={() => setInputMode('database')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                                    inputMode === 'database'
                                        ? 'bg-blue-600 text-white border-blue-600'
                                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                }`}
                            >
                                <Database className="w-4 h-4" /> Scegli da Database
                            </button>
                        </div>
                        )}

                        {inputMode === 'database' ? (
                            <NuovoPiano db={db} onSchoolsReady={handleSchoolsFromDB} />
                        ) : validationPending ? (
                            <ValidationPreview
                                data={validationPending}
                                onConfirm={(data) => {
                                    setValidationPending(null);
                                    handleRawSchoolsReady(data);
                                }}
                                onCancel={() => {
                                    setValidationPending(null);
                                    handleReset();
                                }}
                            />
                        ) : (
                        <FileUpload
                            key={resetKey}
                            onRawSchoolsReady={handleRawSchoolsReady}
                            onValidationNeeded={(data) => setValidationPending(data)}
                            onLoadStart={() => setLoadingState({ active: true, progress: 0, message: 'Inizio caricamento...' })}
                            onLoadProgress={(toUpdate) => setLoadingState(prev => ({ ...prev, ...toUpdate }))}
                            onLoadEnd={() => setLoadingState({ active: false, progress: 100, message: 'Completato' })}
                        />
                        )}
                        {message && (
                            <div className="mt-4 p-4 bg-blue-50 text-blue-700 rounded-md border border-blue-100 flex items-center gap-2">
                                <span className="text-xl">✅</span> {message}
                            </div>
                        )}

                        {correctionInfo && (correctionInfo.corrections.length > 0 || (correctionInfo.unresolvedByAI ?? []).length > 0 || correctionInfo.status === 'rate_limit' || correctionInfo.status === 'error') && (
                            <AddressCorrectionBanner
                                corrections={correctionInfo.corrections}
                                correctedFile={correctionInfo.correctedFile}
                                correctionStatus={correctionInfo.status}
                                unresolvedByAI={correctionInfo.unresolvedByAI ?? []}
                                onManualCorrect={handleManualAddressCorrect}
                            />
                        )}

                        {schools.length > 0 && (
                            <div className="mt-6 bg-gray-50 rounded-xl p-5 border border-gray-200">
                                <h3 className="font-semibold text-gray-700 mb-3 flex justify-between items-center">
                                    <span>Riepilogo Dati Caricati</span>
                                    <div className="flex items-center gap-3">
                                        <button
                                            onClick={() => {
                                                setOpenEditorTrigger(c => c + 1);
                                                setTimeout(() => dashboardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                                            }}
                                            className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
                                        >
                                            ✏️ Modifica Dati
                                        </button>
                                        <button
                                            onClick={() => setShowDetails(!showDetails)}
                                            className="text-sm text-blue-600 hover:text-blue-800 font-medium underline"
                                        >
                                            {showDetails ? 'Nascondi Dettagli' : 'Mostra Dettagli'}
                                        </button>
                                    </div>
                                </h3>

                                <div className="grid grid-cols-2 gap-4 mb-4">
                                    <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                                        <div className="text-gray-500 text-xs uppercase font-bold tracking-wide">Fermate</div>
                                        <div className="text-2xl font-bold text-gray-800">{schools.length}</div>
                                    </div>
                                    <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                                        <div className="text-gray-500 text-xs uppercase font-bold tracking-wide">Passeggeri Totali</div>
                                        <div className="text-2xl font-bold text-blue-600">
                                            {schools.reduce((sum, s) => sum + (parseInt(s.demand) || 0), 0)}
                                        </div>
                                    </div>
                                </div>

                                {showDetails && (
                                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden animate-fade-in mt-4">
                                        <div className="max-h-60 overflow-y-auto">
                                            <table className="min-w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50 sticky top-0">
                                                    <tr>
                                                        <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Nome</th>
                                                        <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Istituto</th>
                                                        <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Indirizzo</th>
                                                        <th scope="col" className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Pax</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-gray-200">
                                                    {schools.map((school) => (
                                                        <tr key={school.id} className="hover:bg-gray-50">
                                                            <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900">{school.name}</td>
                                                            <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                                                                {school.institute ? (
                                                                    <div className="flex items-center gap-2">
                                                                        <div
                                                                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                                                            style={{ backgroundColor: instituteColorMap[school.institute] || '#ccc' }}
                                                                        ></div>
                                                                        <span className="truncate max-w-[120px]" title={school.institute}>
                                                                            {school.institute}
                                                                        </span>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-gray-300">-</span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 truncate max-w-[200px]" title={school.address}>
                                                                {school.address.split(',')[0]} {/* Show just street part if comma separated */}
                                                            </td>
                                                            <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 text-center font-semibold">
                                                                {school.demand}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                        }
                    </section>
                    {/* Section 2: Dashboard (Map + Controls) */}
                    {schools.length > 0 && (
                        <section ref={dashboardRef} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                            <h2 className="text-xl font-semibold mb-4 text-gray-800">2. Ottimizzazione Percorsi</h2>
                            <Dashboard
                                key={currentTripId || 'new'}
                                schools={schools}
                                setSchools={setSchools}
                                instituteColorMap={instituteColorMap}
                                mapsKey={mapsKey}
                                startInEditMode={schools.length === 1 && schools[0].name === 'La mia prima fermata'}
                                currentTripId={currentTripId}
                                onTripSaved={handleTripSaved}
                                onTripRenamed={handleTripRenamed}
                                onTripUpdated={handleTripUpdated}
                                tripToRestore={tripToRestore}
                                openEditorTrigger={openEditorTrigger}
                                allDbInstitutes={allDbInstitutes}
                            />
                        </section>
                    )}
                </div>}
            </main>

            {/* Footer */}
            <footer className="bg-white border-t border-gray-200 mt-auto">
                <div className="max-w-7xl mx-auto py-6 px-4 flex flex-col items-center gap-1 text-gray-500">
                    <div>BusPlan — Pianificazione trasporti</div>
                    {version && <div className="text-[10px] text-gray-400 font-mono">{version}</div>}
                    <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-100 text-[11px] text-gray-400">
                        <span>Sviluppato da</span>
                        <a
                            href="https://aledevv.github.io"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-blue-600 hover:text-blue-700 transition-colors"
                        >
                            Ale Dev
                        </a>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 text-blue-600">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                    </div>
                </div>
            </footer>
        </div>
    );
}

export default App;
