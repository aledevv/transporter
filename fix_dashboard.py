import re
import sys

def main():
    path = "frontend/src/components/Dashboard.jsx"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Remove DownloadDialog and unused imports
    content = re.sub(
        r"import jsPDF from 'jspdf';\nimport autoTable from 'jspdf-autotable';\n",
        r"",
        content
    )
    content = re.sub(
        r"import \{ Document.*?\} from 'docx';\n",
        r"",
        content
    )
    content = re.sub(
        r"// ─── Download Dialog ───.*?// ─── Dashboard ───.*?\n",
        r"// ─── Dashboard ───\n",
        content,
        flags=re.DOTALL
    )

    # 2. Fix state
    content = re.sub(
        r"    // Download dialog \(persisted fields\)\n    const \[downloadDialog, setDownloadDialog\] = useState\(null\); // null \| 'pdf' \| 'docx'\n    const \[docDate, setDocDate\] = useState\(''\);\n    const \[docEventName, setDocEventName\] = useState\(''\);",
        r"    // Document generation settings (persisted fields)\n    const [docDate, setDocDate] = useState('');\n    const [docEventName, setDocEventName] = useState('');\n    const [excludeAutonomia, setExcludeAutonomia] = useState(false);",
        content
    )

    # 3. Fix auto-save hooks
    replacement_hooks = """
    useEffect(() => { setResults(null); setRouteShifts({}); setRouteAdvances({}); setTripName(''); }, [schools]);

    // Track when we're in the middle of restoring a trip (to suppress auto-save)
    const isRestoringRef = React.useRef(false);

    // Restore a saved trip
    useEffect(() => {
        if (!tripToRestore) return;
        isRestoringRef.current = true;
        setDestination(tripToRestore.destination || '');
        setDestCoords(tripToRestore.destCoords || null);
        setCapacity(tripToRestore.capacity);
        setStartTime(tripToRestore.startTime);
        setTimeMode(tripToRestore.timeMode);
        setResults(tripToRestore.results);
        setTripName(tripToRestore.label || '');
        
        // Restore document generation settings and advanced adjustments
        setDocEventName(tripToRestore.docEventName || '');
        setDocDate(tripToRestore.docDate || '');
        setExcludeAutonomia(tripToRestore.excludeAutonomia || false);
        setCalculateReturn(tripToRestore.calculateReturn ?? true);
        setFineManifestazione(tripToRestore.fineManifestazione || '15:00');
        setRouteShifts(tripToRestore.routeShifts || {});
        setRouteAdvances(tripToRestore.routeAdvances || {});
        
        setTimeout(() => { isRestoringRef.current = false; }, 1500);
    }, [tripToRestore]);

    // Debounce tripName changes → rename on Firestore
    useEffect(() => {
        if (!currentTripId || !tripName) return;
        const t = setTimeout(() => { onTripRenamed?.(currentTripId, tripName); }, 700);
        return () => clearTimeout(t);
    }, [tripName, currentTripId]);

    // Auto-save destination + destCoords to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || !destination || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            const fields = { destination, destCoords, stage: 'configured' };
            if (!tripName) {
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                fields.label = `${destination.split(',')[0]} - ${dateStr}`;
            }
            onTripUpdated?.(currentTripId, fields);
        }, 1000);
        return () => clearTimeout(t);
    }, [destination, destCoords, currentTripId]);

    // Auto-save capacity / startTime / timeMode to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { capacity: parseInt(capacity), startTime, timeMode });
        }, 1000);
        return () => clearTimeout(t);
    }, [capacity, startTime, timeMode, currentTripId]);

    // Auto-save document generation settings to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { docEventName, docDate, excludeAutonomia });
        }, 1000);
        return () => clearTimeout(t);
    }, [docEventName, docDate, excludeAutonomia, currentTripId]);

    // Auto-save adjustments and return settings to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { routeShifts, routeAdvances, calculateReturn, fineManifestazione });
        }, 1000);
        return () => clearTimeout(t);
    }, [routeShifts, routeAdvances, calculateReturn, fineManifestazione, currentTripId]);
"""
    content = re.sub(
        r"    useEffect\(\(\) => \{ setResults\(null\); setRouteShifts\(\{\}\); setRouteAdvances\(\{\}\); setTripName\(''\); \}, \[schools\]\);\n.*?// ── helpers ─",
        replacement_hooks + "\n    // ── helpers ─",
        content,
        flags=re.DOTALL
    )

    # 4. Handle optimize results wipe
    setup_opt = """    const handleOptimize = async () => {
        if (!destination) { setError("Inserisci un indirizzo di destinazione."); return; }
        setError(''); setLoading(true); setResults(null); setRouteShifts({}); setRouteAdvances({});"""
    content = re.sub(
        r"    const handleOptimize = async \(\) => \{\n        if \(\!destination\) \{ setError\(\"Inserisci un indirizzo di destinazione\.\"\); return; \}\n        setError\(''\); setLoading\(true\); setResults\(null\);",
        setup_opt,
        content
    )
    
    # Also adjust onTripSaved to include routeShifts, routeAdvances, calculateReturn, fineManifestazione
    on_trip_saved_replace = """                    timeMode,
                    schools,
                    calculateReturn,
                    fineManifestazione,
                    routeShifts: {},
                    routeAdvances: {},
                    results: response.data,
                    label: resolvedName,"""
    content = re.sub(
        r"                    timeMode,\n                    schools,\n                    results: response.data,\n                    label: resolvedName,",
        on_trip_saved_replace,
        content
    )

    # 5. Fix subStopShift
    sub_stop_logic = """    const addStopShift = (vehicleId, displayIdx, prevDistKm) => {
        const increment = (prevDistKm == null || prevDistKm < 10) ? 5 : 10;
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = (cur[displayIdx] || 0) + increment;
            return { ...prev, [vehicleId]: cur };
        });
    };

    const subStopShift = (vehicleId, displayIdx) => {
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = (cur[displayIdx] || 0) - 5;
            return { ...prev, [vehicleId]: cur };
        });
    };"""
    content = re.sub(
        r"    const addStopShift = \(vehicleId, displayIdx, prevDistKm\) => \{.*?\};\n",
        sub_stop_logic + "\n",
        content,
        flags=re.DOTALL
    )

    # 6. Replace PDF and Word completely
    download_backend_logic = """    // ── Document generation (Backend integration) ───────────────────────────────
    const downloadBackendDocument = async (docType, formatType) => {
        try {
            setLoading(true);
            
            // Format the pure YYYY-MM-DD string into an Italian localized verbage
            let formattedDate = docDate;
            if (docDate) {
                const d = new Date(docDate + 'T12:00:00');
                formattedDate = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
            }

            // Apply visual shifts and advances to the routes before sending to backend
            const shiftedRoutes = results.routes.map(r => {
                const newRoute = JSON.parse(JSON.stringify(r));
                const pickupStops = newRoute.outbound.stops.filter(s => s.type === 'pickup');
                const numPickups = pickupStops.length;
                const totalShift = getTotalShift(newRoute.vehicle_id, numPickups);
                const advance = getRouteAdvance(newRoute.vehicle_id);
                
                let pickupIdx = 0;
                newRoute.outbound.stops.forEach(stop => {
                    if (stop.type === 'destination') {
                        if (stop.arrival_time) {
                            stop.arrival_time = shiftTime(stop.arrival_time, totalShift + advance);
                        }
                    } else if (stop.type === 'pickup') {
                        const cumShift = getCumulativeShift(newRoute.vehicle_id, pickupIdx) + advance;
                        if (stop.departure_time) {
                            stop.departure_time = shiftTime(stop.departure_time, cumShift);
                        }
                        pickupIdx++;
                    }
                });
                return newRoute;
            });

            const response = await axios.post(`${API_BASE_URL}/api/export_document`, {
                doc_type: docType,
                format: formatType,
                event_name: docEventName,
                date: formattedDate,
                destination: destination,
                start_time: startTime,
                end_time: fineManifestazione,
                exclude_autonomia: excludeAutonomia,
                routes: shiftedRoutes
            }, { responseType: 'blob' });

            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            const ext = formatType === 'pdf' ? 'pdf' : 'docx';
            const baseName = docType === 'piano_viaggi' ? 'Piano_Viaggi' : 'Richiesta_Servizio';
            link.setAttribute('download', `${baseName}_${docEventName || 'Evento'}.${ext}`);
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (err) {
            console.error("Download failed", err);
            alert("Errore durante la generazione del documento backend.");
        } finally {
            setLoading(false);
        }
    };"""
    content = re.sub(
        r"    // ── PDF generation ──.*?    const handleConfirmDownload = async \(\) => \{\n.*?setDownloadDialog\(null\);\n    \};\n",
        download_backend_logic + "\n",
        content,
        flags=re.DOTALL
    )

    # 7. Remove DownloadDialog in return block
    content = re.sub(
        r"            \{\/\* Download Dialog \*\/.*?            \}\n\n            \{\/\* Top Row",
        r"            {/* Top Row",
        content,
        flags=re.DOTALL
    )

    # 8. Remove the Advance Departure block completely
    advance_departure = r"                                                \{/\* Advance departure \*/\}.*?                                                </div>\n"
    content = re.sub(
        advance_departure,
        r"\n",
        content,
        flags=re.DOTALL
    )

    # 9. Change addStopShift button rendering to include the subStopShift functionality
    old_btn = r"""                                                                        <button
                                                                            onClick=\{\(\) => addStopShift\(route.vehicle_id, curIdx, prevDist\)\}
                                                                            title=\{`\+\$\{bufIncrement\} min a questa e alle successive fermate`\}
                                                                            className="flex items-center gap-0\.5 text-\[10px\] text-orange-500 hover:text-orange-700 font-medium px-1\.5 py-0\.5 rounded-full border border-orange-200 hover:bg-orange-50 transition-colors"
                                                                        >
                                                                            <PlusCircle className="w-2\.5 h-2\.5" \/>\+\{bufIncrement\}′
                                                                        <\/button>"""
    new_btn = """                                                                        <div className="flex items-center gap-1">
                                                                            <button
                                                                                onClick={() => subStopShift(route.vehicle_id, curIdx)}
                                                                                title="-5 min a questa e alle successive fermate"
                                                                                className="flex items-center gap-0.5 text-[10px] text-blue-500 hover:text-blue-700 font-medium px-1.5 py-0.5 rounded-full border border-blue-200 hover:bg-blue-50 transition-colors"
                                                                            >
                                                                                −5′
                                                                            </button>
                                                                            <button
                                                                                onClick={() => addStopShift(route.vehicle_id, curIdx, prevDist)}
                                                                                title={`+${bufIncrement} min a questa e alle successive fermate`}
                                                                                className="flex items-center gap-0.5 text-[10px] text-orange-500 hover:text-orange-700 font-medium px-1.5 py-0.5 rounded-full border border-orange-200 hover:bg-orange-50 transition-colors"
                                                                            >
                                                                                <PlusCircle className="w-2.5 h-2.5" />+{bufIncrement}′
                                                                            </button>
                                                                        </div>"""
    content = re.sub(old_btn, new_btn, content)

    # 10. Replace the 'Trip name + Export' block
    old_trip_export = r"                        \{/\* Trip name \+ Export \*/\}.*?                        </div>\n                    </div>\n                </div>\n            \)\}"
    new_trip_export = """                        <div className="border-t border-gray-100 p-4 bg-gray-50 flex flex-col md:flex-row gap-4">
                            {/* Naming Section */}
                            <div className="flex-1 space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1.5">
                                        <Bookmark className="w-3.5 h-3.5 text-blue-400" />
                                        Nome viaggio (salvato nello storico)
                                    </label>
                                    <input
                                        type="text"
                                        value={tripName}
                                        onChange={e => setTripName(e.target.value)}
                                        placeholder={`${destination.split(',')[0]} · ${new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-blue-300 outline-none text-gray-700 placeholder:text-gray-400"
                                    />
                                </div>
                            </div>

                            {/* Export Section */}
                            <div className="flex-[1.5] bg-white rounded-xl border border-blue-100 p-4 shadow-sm relative overflow-hidden">
                                <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
                                <h4 className="text-sm font-semibold text-blue-800 mb-3 flex items-center gap-1.5">
                                    <FileText className="w-4 h-4" />
                                    Documentazione (Word)
                                </h4>
                                
                                <div className="grid grid-cols-2 gap-3 mb-4">
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Data evento</label>
                                        <input
                                            type="date"
                                            value={docDate}
                                            onChange={e => setDocDate(e.target.value)}
                                            className="w-full px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-blue-400"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Nome evento</label>
                                        <input
                                            type="text"
                                            value={docEventName}
                                            onChange={e => setDocEventName(e.target.value)}
                                            placeholder="es. Torneo Provinciale"
                                            className="w-full px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-blue-400"
                                        />
                                    </div>
                                    <div className="col-span-2 pt-1 border-t border-gray-100 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                                checked={excludeAutonomia}
                                                onChange={e => setExcludeAutonomia(e.target.checked)}
                                            />
                                            <span className="text-sm font-medium text-gray-700">Nascondi scuole in autonomia</span>
                                        </label>
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => downloadBackendDocument('piano_viaggi', 'docx')}
                                        className="flex-1 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 flex items-center justify-center gap-2 shadow-sm transition-colors text-sm"
                                    >
                                        <Download className="w-4 h-4" /> Piano Viaggi
                                    </button>
                                    <button
                                        onClick={() => downloadBackendDocument('richiesta_servizio', 'docx')}
                                        className="flex-1 py-2 rounded-lg font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 flex items-center justify-center gap-2 transition-colors text-sm"
                                    >
                                        <FileText className="w-4 h-4" /> Richiesta Preventivo
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}"""
    content = re.sub(old_trip_export, new_trip_export, content, flags=re.DOTALL)

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

if __name__ == "__main__":
    main()
