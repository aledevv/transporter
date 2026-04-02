import React from 'react';
import { Clock, Play, X } from 'lucide-react';

const stageLabel = (stage, destination) => {
    switch (stage) {
        case 'optimized': return 'Piano calcolato';
        case 'configured': return destination ? `Destinazione: ${destination.split(',')[0]}` : 'Configurato';
        case 'uploaded': return 'Fermate caricate';
        default: return 'Lavoro in corso';
    }
};

const formatTs = (timestamp) => {
    if (!timestamp) return '';
    try {
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
};

const ResumeWorkBanner = ({ trip, onRestore, onDismiss }) => {
    const ts = formatTs(trip.updatedAt || trip.savedAt);
    return (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between gap-4 animate-fade-in">
            <div className="flex items-start gap-3 min-w-0">
                <Clock className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{trip.label || 'Lavoro precedente'}</p>
                    <p className="text-sm text-gray-500">
                        {stageLabel(trip.stage, trip.destination)}
                        {ts && <span className="ml-1">· {ts}</span>}
                    </p>
                </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
                <button
                    onClick={onDismiss}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    title="Ignora"
                >
                    <X className="w-4 h-4" />
                </button>
                <button
                    onClick={() => onRestore(trip)}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Play className="w-3.5 h-3.5" />
                    Riprendi
                </button>
            </div>
        </div>
    );
};

export default ResumeWorkBanner;
