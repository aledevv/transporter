import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Menu } from 'lucide-react';
import { collection, query, orderBy, limit, onSnapshot, addDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';
import AddressCorrectionBanner from './components/AddressCorrectionBanner';
import GeocodingFailuresModal from './components/GeocodingFailuresModal';
import TripSidebar from './components/TripSidebar';
import { getInstituteColorMap } from './utils/colors';
import API_BASE_URL from './config';

// Simple Loading Overlay Component
const LoadingOverlay = ({ progress, message }) => {
    const isAI = message?.includes('AI');
    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999] flex flex-col items-center justify-center animate-fade-in">
            <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 max-w-sm w-full mx-4">
                <div className="relative w-16 h-16">
                    <div className={`absolute inset-0 border-4 ${isAI ? 'border-orange-100' : 'border-blue-100'} rounded-full`}></div>
                    <div className={`absolute inset-0 border-4 ${isAI ? 'border-orange-500' : 'border-blue-600'} rounded-full border-t-transparent animate-spin`}></div>
                </div>
                <div className="text-center w-full">
                    <h3 className={`text-lg font-bold ${isAI ? 'text-orange-600' : 'text-gray-800'} flex items-center justify-center gap-2`}>
                        {isAI && <Sparkles className="w-5 h-5" />}
                        {isAI ? 'Intelligenza Artificiale al lavoro...' : 'Elaborazione in corso...'}
                    </h3>
                    <p className={`text-sm ${isAI ? 'text-orange-500 font-medium' : 'text-gray-500'} mt-1 mb-3`}>{message || 'Preparazione dati...'}</p>

                    {/* Progress Bar */}
                    <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        {isAI ? (
                            <div className="h-2.5 rounded-full bg-orange-400 animate-pulse" style={{ width: '100%' }} />
                        ) : (
                            <div
                                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${Math.max(5, progress || 0)}%` }}
                            />
                        )}
                    </div>
                    {!isAI && <p className="text-xs text-gray-400 mt-1 text-right">{progress || 0}%</p>}
                </div>
            </div>
        </div>
    );
};

function App() {
    const [schools, setSchools] = useState([]);
    const [message, setMessage] = useState('');
    const [showDetails, setShowDetails] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    const [loadingState, setLoadingState] = useState({ active: false, progress: 0, message: '' }); // Global loading state
    const [correctionInfo, setCorrectionInfo] = useState(null); // { corrections, correctedFile }
    const [geocodingFailures, setGeocodingFailures] = useState(null); // schools with geocoding_failed:true
    const [version, setVersion] = useState('');
    // null = not yet fetched (Map must not render until this is set)
    const [mapsKey, setMapsKey] = useState(null);

    // Trip history (Firestore)
    const [trips, setTrips] = useState([]);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [tripToRestore, setTripToRestore] = useState(null);

    // Subscribe to Firestore trip history
    useEffect(() => {
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
    }, []);

    useEffect(() => {
        fetch('/version.txt')
            .then(res => res.text())
            .then(text => setVersion(text.trim()))
            .catch(err => console.error('Error fetching version:', err));
        fetch(`${API_BASE_URL}/api/config`)
            .then(r => r.json())
            .then(d => setMapsKey(d.maps_key || ''))
            .catch(err => {
                console.error('Error fetching config:', err);
                setMapsKey(''); // unblock Map even if config fails
            });
    }, []);

    const handleTripSaved = async (tripData) => {
        try {
            const docRef = await addDoc(collection(db, 'trips'), {
                ...tripData,
                results: JSON.stringify(tripData.results),
            });
            return docRef.id;
        } catch (err) {
            console.warn('Failed to save trip:', err.message);
            return null;
        }
    };

    const handleTripRenamed = async (tripId, newName) => {
        try {
            await updateDoc(doc(db, 'trips', tripId), { label: newName });
        } catch (err) {
            console.warn('Failed to rename trip:', err.message);
        }
    };

    const handleTripRestore = (trip) => {
        const restored = {
            ...trip,
            results: typeof trip.results === 'string' ? JSON.parse(trip.results) : trip.results,
        };
        setSchools(restored.schools);
        setTripToRestore(restored);
        setSidebarOpen(false);
    };

    const handleTripDelete = async (tripId) => {
        try {
            await deleteDoc(doc(db, 'trips', tripId));
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
        <div className="min-h-screen bg-gray-50 flex flex-col">
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

            {/* Header */}
            <header className="bg-white shadow">
                <div className="container mx-auto py-6 px-4 flex justify-between items-center">
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
            <main className="flex-grow container mx-auto px-4 py-8">
                <div className="space-y-8">
                    {/* Section 1: Upload */}
                    <section ref={uploadRef} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                        <h2 className="text-xl font-semibold mb-4 text-gray-800">1. Importazione Dati</h2>
                        <FileUpload
                            key={resetKey}
                            onUploadSuccess={({ schools: data, correctedFile, addressCorrections, correctionStatus }) => {
                                setSchools(data);
                                setMessage('File caricato con successo! Procedi alla configurazione.');
                                setCorrectionInfo({
                                    corrections: addressCorrections ?? [],
                                    correctedFile,
                                    status: correctionStatus,
                                });
                                // Show modal for any addresses that couldn't be geocoded
                                const failed = data.filter(s => s.geocoding_failed);
                                if (failed.length > 0) setGeocodingFailures(failed);
                            }}
                            onLoadStart={() => setLoadingState({ active: true, progress: 0, message: 'Inizio caricamento...' })}
                            onLoadProgress={(toUpdate) => setLoadingState(prev => ({ ...prev, ...toUpdate }))}
                            onLoadEnd={() => setLoadingState({ active: false, progress: 100, message: 'Completato' })}
                        />
                        {message && (
                            <div className="mt-4 p-4 bg-blue-50 text-blue-700 rounded-md border border-blue-100 flex items-center gap-2">
                                <span className="text-xl">✅</span> {message}
                            </div>
                        )}

                        {correctionInfo && (correctionInfo.corrections.length > 0 || correctionInfo.status === 'rate_limit' || correctionInfo.status === 'error') && (
                            <AddressCorrectionBanner
                                corrections={correctionInfo.corrections}
                                correctedFile={correctionInfo.correctedFile}
                                correctionStatus={correctionInfo.status}
                                onManualCorrect={handleManualAddressCorrect}
                            />
                        )}

                        {schools.length > 0 && (
                            <div className="mt-6 bg-gray-50 rounded-xl p-5 border border-gray-200">
                                <h3 className="font-semibold text-gray-700 mb-3 flex justify-between items-center">
                                    <span>Riepilogo Dati Caricati</span>
                                    <button
                                        onClick={() => setShowDetails(!showDetails)}
                                        className="text-sm text-blue-600 hover:text-blue-800 font-medium underline"
                                    >
                                        {showDetails ? 'Nascondi Dettagli' : 'Mostra Dettagli'}
                                    </button>
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

                        {/* Manual Entry Option */}
                        <div className="mt-6 pt-6 border-t border-gray-100">
                            <h3 className="text-sm font-medium text-gray-700 mb-2">Oppure inizia da zero:</h3>
                            <button
                                onClick={() => {
                                    // Initialize with one empty school to trigger dashboard and editor
                                    setSchools([{
                                        id: 1,
                                        name: 'La mia prima fermata',
                                        address: '',
                                        demand: 1,
                                        lat: 0,
                                        lon: 0
                                    }]);
                                    setMessage('Modalità inserimento manuale avviata.');
                                }}
                                className="text-sm text-blue-600 font-medium hover:text-blue-800 hover:underline cursor-pointer"
                            >
                                + Clicca qui per inserire indirizzi manualmente
                            </button>
                        </div>
                    </section>

                    {/* Section 2: Dashboard (Map + Controls) */}
                    {schools.length > 0 && (
                        <section ref={dashboardRef} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                            <h2 className="text-xl font-semibold mb-4 text-gray-800">2. Ottimizzazione Percorsi</h2>
                            <Dashboard
                                schools={schools}
                                setSchools={setSchools}
                                instituteColorMap={instituteColorMap}
                                mapsKey={mapsKey}
                                startInEditMode={schools.length === 1 && schools[0].name === 'La mia prima fermata'}
                                onTripSaved={handleTripSaved}
                                onTripRenamed={handleTripRenamed}
                                tripToRestore={tripToRestore}
                            />
                        </section>
                    )}
                </div>
            </main>

            {/* Footer */}
            <footer className="bg-white border-t border-gray-200 mt-auto">
                <div className="max-w-7xl mx-auto py-6 px-4 flex flex-col items-center gap-1 text-gray-500">
                    <div>BusPlan - Pianificazione trasporti</div>
                    {version && <div className="text-[10px] text-gray-400 font-mono">{version}</div>}
                </div>
            </footer>
        </div>
    );
}

export default App;
