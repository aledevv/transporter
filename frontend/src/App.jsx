import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Menu, FileSpreadsheet, Database } from 'lucide-react';
import { collection, query, orderBy, limit, onSnapshot, addDoc, deleteDoc, doc, updateDoc, serverTimestamp, getDocs, setDoc, arrayUnion } from 'firebase/firestore';
import { initFirebase } from './firebase';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';
import SheetReviewModal from './components/SheetReviewModal';
import SheetReviewCallout, { ReadyCard } from './components/SheetReviewCallout';
import { aliasToLearn } from './utils/matchInstitutes';
import { analyzeTripRows, buildTripPayload } from './utils/sheetIssues';
import { destinationPlaces } from './utils/placeMatch';
import TripSidebar from './components/TripSidebar';
import ResumeWorkBanner from './components/ResumeWorkBanner';
import InstituteList from './components/InstituteList';
import NuovoPiano from './components/NuovoPiano';
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
    const [resetKey, setResetKey] = useState(0);
    const [loadingState, setGlobalLoading] = useState({ active: false, progress: 0, message: '' }); // Global loading state
    const setLoadingState = setGlobalLoading;
    const [processingError, setProcessingError] = useState(null); // Error message string | null
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
    // FileUpload keeps the callback from the render when the upload started, so
    // read the latest institutes and db through refs instead of the closure
    const allDbInstitutesRef = useRef([]);
    const dbRef = useRef(null);
    useEffect(() => { allDbInstitutesRef.current = allDbInstitutes; }, [allDbInstitutes]);
    useEffect(() => { dbRef.current = db; }, [db]);
    // Excel under review: { fileName, columns, rows, saved: {resolutions, edits}, processed, open }
    const [review, setReview] = useState(null);

    const loadInstitutes = async () => {
        let institutes = allDbInstitutesRef.current;
        // The live subscription may not have delivered yet: load once before matching
        if (institutes.length === 0 && dbRef.current) {
            try {
                const snap = await getDocs(collection(dbRef.current, 'institutes'));
                institutes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                setAllDbInstitutes(institutes);
            } catch (err) {
                console.warn('Failed to load institutes for matching:', err);
            }
        }
        return institutes;
    };

    const handleSheetRead = async ({ fileName, columns, rows }) => {
        await loadInstitutes();
        setProcessingError(null);
        setReview({ fileName, columns, rows, saved: null, processed: false, open: true });
    };

    // Destination dropdown: saved trips' destinations and non-school database places
    const destinationSuggestions = useMemo(() => destinationPlaces(allDbInstitutes, trips), [allDbInstitutes, trips]);

    const reviewAnalysis = useMemo(
        () => (review ? analyzeTripRows(review.rows, review.columns, allDbInstitutes) : null),
        [review?.rows, review?.columns, allDbInstitutes], // eslint-disable-line react-hooks/exhaustive-deps
    );

    // Problems still open with the choices saved when the window was closed (for the callout)
    const reviewCounts = useMemo(() => {
        if (!reviewAnalysis) return { errors: 0, warnings: 0 };
        const res = review?.saved?.resolutions || {};
        const edits = review?.saved?.edits || {};
        const open = reviewAnalysis.issues.filter(i => {
            if (res[i.row]?.type === 'skip') return false;
            if (i.fix === 'number') return !(Number(edits[`${i.row}|${i.col}`]) > 0);
            return res[i.row] === undefined;
        });
        return {
            errors: open.filter(i => i.severity === 'error').length + (reviewAnalysis.missingColumns?.length ? 1 : 0),
            warnings: open.filter(i => i.severity === 'warning').length,
        };
    }, [reviewAnalysis, review?.saved]);

    const handleReviewConfirm = async ({ resolutions, userResolutions, edits }) => {
        setReview(r => ({ ...r, open: false, processed: true, processing: true, saved: { resolutions: userResolutions, edits } }));
        const { rawSchools, resolutions: backendResolutions, newStops } = buildTripPayload(review.rows, reviewAnalysis, resolutions, edits);
        if (rawSchools.length === 0) {
            setReview(r => ({ ...r, processing: false }));
            setProcessingError('Nessuna fermata da pianificare: sono state escluse tutte.');
            return;
        }

        if (db) {
            const writes = [];
            // New stops go into the dataset as name / street / coordinates
            newStops.forEach(n => {
                const type = /(ic\b|istituto|scuola|liceo|polo|primaria|secondaria)/i.test(n.name) ? 'istituto' : 'destinazione';
                writes.push(setDoc(doc(db, 'institutes', makeStableId(n.name, n.address)), {
                    name: n.name,
                    description: n.address,
                    originalName: n.excelName,
                    address: n.address,
                    lat: n.lat,
                    lon: n.lon,
                    type,
                    updatedAt: serverTimestamp(),
                }, { merge: true }));
            });
            // A stop matched to an existing entry under another name: remember that
            // name as an alias, so the next Excel using it matches directly
            Object.entries(userResolutions || {}).forEach(([row, res]) => {
                if (res?.type !== 'db') return;
                const excelName = String(review.rows[row]?.[reviewAnalysis.nameCol] ?? '');
                const alias = aliasToLearn(excelName, res.entry);
                if (alias) writes.push(updateDoc(doc(db, 'institutes', res.entry.id), { aliases: arrayUnion(alias) }));
            });
            if (writes.length > 0) {
                Promise.all(writes).catch(err => console.error('Error saving to Firestore:', err));
            }
        }

        await continueProcessing(null, backendResolutions, '/api/start-processing', {
            raw_schools: rawSchools,
            resolutions: backendResolutions,
        }, { keepSettings: review.processed, silent: true });
    };

    // The review card stops showing "in preparazione" when processing ends, either way
    useEffect(() => {
        if (processingError) setReview(r => (r?.processing ? { ...r, processing: false } : r));
    }, [processingError]);

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
                    setDb(initFirebase(d.firebase, d.appCheckSiteKey));
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

    // keepSettings: the stops were re-reviewed after the trip was already set up,
    // so only the stops change (destination, times... stay as they are)
    const handleUploadComplete = async ({ result: data, keepSettings = false }) => {
        setSchools(data);
        setResumeDismissed(true);
        setReview(r => (r?.processing ? { ...r, processing: false } : r));
        setMessage('Fermate pronte: ora scegli destinazione e orari.');
        if (db) {
            try {
                const totalPax = data.reduce((s, sc) => s + (parseInt(sc.demand) || 0), 0);
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const label = data.length > 0
                    ? `${data.length} fermate, ${totalPax} passeggeri - ${dateStr}`
                    : `Nuovo lavoro - ${dateStr}`;
                if (currentTripId && keepSettings) {
                    await updateDoc(doc(db, 'trips', currentTripId), { schools: data, updatedAt: serverTimestamp() });
                } else if (currentTripId) {
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

    // silent: no full-screen overlay (after the review window, which shows the work in its card)
    const continueProcessing = async (taskId, resolutions, endpoint = '/api/start-processing', body = null, { keepSettings = false, silent = false } = {}) => {
        const setLoadingState = silent ? () => {} : setGlobalLoading;
        setLoadingState({ active: true, progress: 20, message: 'Geocoding...' });
        try {
            const requestBody = body ?? { task_id: taskId, resolutions };
            const resp = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            // Check HTTP-level errors (4xx/5xx) before trying to parse
            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                console.error(`continueProcessing: HTTP ${resp.status} from ${endpoint}:`, errData);
                setLoadingState({ active: false, progress: 0, message: '' });
                setProcessingError(errData.error || `Errore del server (HTTP ${resp.status}). Riprova ricaricando il file.`);
                return;
            }

            const respData = await resp.json();
            const pollId = respData.task_id;

            // Guard: if backend didn't return a task_id stop immediately
            if (!pollId) {
                console.error('continueProcessing: no task_id in response', respData);
                setLoadingState({ active: false, progress: 0, message: '' });
                return;
            }

            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/api/status/${pollId}`);
                    if (!statusRes.ok) {
                        console.error(`continueProcessing poll: HTTP ${statusRes.status} for task ${pollId}`);
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 0, message: '' });
                        setProcessingError('Il server ha perso lo stato dell\'elaborazione (riavvio?). Ricarica il file per riprovare.');
                        return;
                    }
                    const statusData = await statusRes.json();
                    const { status, result, progress, message } = statusData;
                    setLoadingState(prev => ({
                        ...prev,
                        progress: progress || 0,
                        message: message || '',
                    }));
                    if (status === 'completed') {
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 100, message: 'Completato' });
                        await handleUploadComplete({ result, keepSettings });
                    } else if (status === 'error') {
                        console.error('continueProcessing poll: task error:', statusData.message);
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 0, message: '' });
                        setProcessingError(statusData.message || 'Errore durante l\'elaborazione. Riprova.');
                    } else if (!status) {
                        // Unexpected response shape
                        console.error('continueProcessing poll: unexpected response', statusData);
                        clearInterval(pollInterval);
                        setLoadingState({ active: false, progress: 0, message: '' });
                    }
                } catch (e) {
                    console.error('continueProcessing poll exception:', e);
                    clearInterval(pollInterval);
                    setLoadingState({ active: false, progress: 0, message: '' });
                    setProcessingError('Connessione persa durante l\'elaborazione. Controlla il server e riprova.');
                }
            }, 1000);
        } catch (e) {
            console.error('continueProcessing error', e);
            setLoadingState({ active: false, progress: 0, message: '' });
        }
    };

    const handleTripRestore = (trip) => {
        setSidebarOpen(false);
        if (trip.stage === 'db_match_pending') {
            // Saved by the old address check before it was finished: review its stops again
            setCurrentTripId(trip.id);
            const rows = (trip.schools || []).map(s => ({ Nome: s.name, Indirizzo: s.display_address || s.address, Partecipanti: s.demand ?? '' }));
            handleSheetRead({ fileName: trip.label || 'Viaggio salvato', columns: ['Nome', 'Indirizzo', 'Partecipanti'], rows });
            return;
        }
        setReview(null);
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
        setCurrentTripId(null);
        setTripToRestore(null);
        setReview(null);
        setResumeDismissed(false);
        setInputMode('excel');
        setProcessingError(null);
        setResetKey(prev => prev + 1); // Force FileUpload to remount and clear input
    };

    const handleSchoolsFromDB = async (schoolsFromDB) => {
        setSchools(schoolsFromDB);
        setResumeDismissed(true);
        setMessage('Fermate caricate dal database: ora scegli destinazione e orari.');
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
            {review?.open && reviewAnalysis && (
                <SheetReviewModal
                    mode="trip"
                    title="Controlla le fermate del viaggio"
                    fileName={review.fileName}
                    columns={reviewAnalysis.shownColumns || review.columns}
                    rows={review.rows.slice(0, reviewAnalysis.tableRows ?? review.rows.length)}
                    issues={reviewAnalysis.issues}
                    initialResolutions={reviewAnalysis.resolutions}
                    candidatesByRow={reviewAnalysis.candidatesByRow}
                    institutes={allDbInstitutes}
                    nameCol={reviewAnalysis.nameCol}
                    addrCol={reviewAnalysis.addrCol}
                    missingColumns={reviewAnalysis.missingColumns}
                    savedState={review.saved}
                    confirmLabel={review.processed ? 'Aggiorna le fermate' : undefined}
                    onConfirm={handleReviewConfirm}
                    onClose={saved => setReview(r => ({ ...r, open: false, saved }))}
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
                            <img src="/favicon.svg" alt="BusPlan Logo" className="w-9 h-9 md:w-10 md:h-10" />
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
                    <section className="h-[calc(100vh-9.5rem)] min-h-[560px] flex-shrink-0 bg-white p-4 rounded-lg shadow-sm border border-gray-100 flex flex-col overflow-hidden">
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
                        ) : (
                        <>
                        <FileUpload
                            key={resetKey}
                            onSheetRead={handleSheetRead}
                            onLoadStart={() => setLoadingState({ active: true, progress: 10, message: 'Lettura del foglio Excel...' })}
                            onLoadEnd={() => setLoadingState({ active: false, progress: 100, message: '' })}
                        />
                        {review && !review.open && (
                            <SheetReviewCallout
                                processing={review.processing}
                                stops={review.processed && !review.processing ? schools.length : null}
                                passengers={schools.reduce((n, sc) => n + (parseInt(sc.demand) || 0), 0)}
                                onNext={() => dashboardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                fileName={review.fileName}
                                rowCount={reviewAnalysis?.tableRows ?? review.rows.length}
                                openErrors={reviewCounts.errors}
                                openWarnings={reviewCounts.warnings}
                                processed={review.processed}
                                onOpen={() => setReview(r => ({ ...r, open: true }))}
                            />
                        )}
                        </>
                        )}
                        {message && schools.length > 0 && !review && (
                            <ReadyCard
                                stops={schools.length}
                                passengers={schools.reduce((n, sc) => n + (parseInt(sc.demand) || 0), 0)}
                                text={message}
                                onNext={() => dashboardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                            />
                        )}

                        {processingError && (
                            <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-md border border-red-200 flex items-start gap-3">
                                <span className="text-xl flex-shrink-0">⚠️</span>
                                <div>
                                    <p className="font-semibold">Errore durante l'elaborazione</p>
                                    <p className="text-sm mt-1">{processingError}</p>
                                    <button
                                        onClick={() => { setProcessingError(null); setResetKey(prev => prev + 1); }}
                                        className="mt-2 text-xs font-medium text-red-700 underline hover:text-red-900"
                                    >
                                        Ricarica il file
                                    </button>
                                </div>
                            </div>
                        )}

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
                                allDbInstitutes={allDbInstitutes}
                                destinationPlaces={destinationSuggestions}
                            />
                        </section>
                    )}
                </div>}

                {/* Footer: last thing on the page, scrolls with the content */}
                <footer className="mt-10 border-t border-gray-200 flex-shrink-0">
                    <div className="py-6 flex flex-col items-center gap-1 text-gray-500">
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
            </main>

        </div>
    );
}

export default App;
