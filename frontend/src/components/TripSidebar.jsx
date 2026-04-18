import React from 'react';
import { X, Trash2, History, Bus, Users, Clock } from 'lucide-react';

const TripSidebar = ({ open, trips, onRestore, onDelete, onClose }) => {
    return (
        <>
            {/* Backdrop */}
            {open && (
                <div
                    className="fixed inset-0 bg-black/30 z-40"
                    onClick={onClose}
                />
            )}

            {/* Sidebar panel */}
            <div
                className={`fixed top-0 left-0 h-full w-72 bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100 bg-gray-50">
                    <span className="flex items-center gap-2 font-semibold text-gray-700 text-sm">
                        <History className="w-4 h-4 text-blue-500" />
                        Viaggi Salvati
                    </span>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-200 transition-colors">
                        <X className="w-4 h-4 text-gray-500" />
                    </button>
                </div>

                {/* Trip list */}
                <div className="flex-1 overflow-y-auto">
                    {trips.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center px-6 text-gray-400">
                            <History className="w-10 h-10 mb-3 opacity-30" />
                            <p className="text-sm font-medium">Nessun viaggio salvato</p>
                            <p className="text-xs mt-1">I risultati di ottimizzazione vengono salvati automaticamente.</p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {trips.map(trip => {
                                const isPending = trip.stage === 'db_match_pending';
                                const busCount = trip.results?.routes?.length ?? '–';
                                const passengerCount = trip.results?.stats?.total_passengers ?? '–';
                                return (
                                    <li key={trip.id} className={`group flex items-start gap-2 px-4 py-3 transition-colors cursor-pointer ${isPending ? 'hover:bg-amber-50' : 'hover:bg-blue-50'}`} onClick={() => onRestore(trip)}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-gray-800 truncate">{trip.label}</div>
                                            <div className="flex items-center gap-3 mt-1">
                                                {isPending ? (
                                                    <span className="flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                                                        <Clock className="w-3 h-3" /> In verifica
                                                    </span>
                                                ) : (
                                                    <>
                                                        <span className="flex items-center gap-1 text-[11px] text-gray-500">
                                                            <Bus className="w-3 h-3" /> {busCount} bus
                                                        </span>
                                                        <span className="flex items-center gap-1 text-[11px] text-gray-500">
                                                            <Users className="w-3 h-3" /> {passengerCount} pax
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            onClick={e => { e.stopPropagation(); onDelete(trip.id); }}
                                            className="flex-shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 transition-all mt-0.5"
                                            title="Elimina viaggio"
                                        >
                                            <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
};

export default TripSidebar;
