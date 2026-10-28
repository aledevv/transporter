import React from 'react';
import { FileSpreadsheet, ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';

// Small callout under the upload area to reopen the review window once it's closed
export default function SheetReviewCallout({ fileName, rowCount, openErrors, openWarnings, processed, onOpen }) {
    const pending = openErrors > 0;
    const tone = pending
        ? 'border-rose-200 bg-rose-50/70 text-rose-900'
        : processed ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900' : 'border-blue-200 bg-blue-50/60 text-blue-900';
    const Icon = pending ? AlertTriangle : processed ? CheckCircle2 : FileSpreadsheet;
    const title = pending
        ? `${openErrors} ${openErrors === 1 ? 'fermata da rivedere' : 'fermate da rivedere'}`
        : processed ? 'Revisione completata' : 'Revisione pronta';
    const detail = [
        fileName,
        `${rowCount} righe`,
        openWarnings > 0 && `${openWarnings} da verificare`,
    ].filter(Boolean).join(' · ');

    return (
        <div className={`sr-rise-in mt-4 flex items-center gap-3 rounded-xl border px-4 py-3 ${tone}`}>
            <Icon className="h-5 w-5 flex-shrink-0 opacity-80" />
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{title}</div>
                <div className="truncate text-xs opacity-75">{detail}</div>
            </div>
            <button
                onClick={onOpen}
                className="group inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium shadow-sm ring-1 ring-black/5 transition-all hover:shadow"
            >
                {pending ? 'Apri revisione' : 'Riapri'}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
        </div>
    );
}
