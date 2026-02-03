import React, { useState, useRef, useEffect } from 'react';
import FileUpload from './components/FileUpload';
import Dashboard from './components/Dashboard';

function App() {
    const [schools, setSchools] = useState([]);
    const [message, setMessage] = useState('');

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

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col">
            {/* Header */}
            <header className="bg-white shadow">
                <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
                    <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
                        🚌 Transporter
                        <span className="text-sm font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded-md">Beta</span>
                    </h1>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-grow container mx-auto px-4 py-8">
                <div className="space-y-8">
                    {/* Section 1: Upload */}
                    <section ref={uploadRef} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                        <h2 className="text-xl font-semibold mb-4 text-gray-800">1. Importazione Dati</h2>
                        <FileUpload
                            onUploadSuccess={(data) => {
                                setSchools(data);
                                setMessage('File caricato con successo! Procedi alla configurazione.');
                            }}
                        />
                        {message && (
                            <div className="mt-4 p-4 bg-blue-50 text-blue-700 rounded-md border border-blue-100">
                                {message}
                            </div>
                        )}
                        {schools.length > 0 && (
                            <div className="mt-4 text-sm text-gray-600">
                                Caricate {schools.length} posizioni dal file.
                            </div>
                        )}

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
                                // Simple heuristic: if we have 1 school called "My First Stop" (created by the button), it's likely a manual start
                                // Or we could add a state "isManual" to App
                                startInEditMode={schools.length === 1 && schools[0].name === 'La mia prima fermata'}
                            />
                        </section>
                    )}
                </div>
            </main>

            {/* Footer */}
            <footer className="bg-white border-t border-gray-200 mt-auto">
                <div className="max-w-7xl mx-auto py-6 px-4 text-center text-gray-500">
                    Transporter Project - Pianificazione trasporti
                </div>
            </footer>
        </div>
    );
}

export default App;
