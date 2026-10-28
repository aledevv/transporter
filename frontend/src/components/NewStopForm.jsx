import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, X } from 'lucide-react';
import { parseCoordinates, formatCoordinates } from '../utils/coordinates';
import AddressAutocomplete from './AddressAutocomplete';

export const STREET_HINT = 'Il nome che appare in grafica e nei documenti, scritto in breve';

function googleMapsUrl(query) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function CoordinateField({ value, onChange }) {
    const parsed = value.trim() ? parseCoordinates(value) : null;
    return (
        <div>
            <input
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder="46.0697, 11.1211"
                className={`w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none transition-colors ${
                    !parsed ? 'border-slate-200 focus:border-blue-400'
                        : parsed.ok ? 'border-emerald-300 focus:border-emerald-500' : 'border-rose-300 focus:border-rose-500'
                }`}
            />
            <div className="mt-1 min-h-[18px] text-xs">
                {!parsed && <span className="text-slate-400">Incolla le coordinate copiate da Google Maps</span>}
                {parsed && parsed.ok && (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                        <Check className="h-3 w-3" /> {formatCoordinates(parsed.lat, parsed.lon)}
                        {parsed.warning && <span className="text-amber-600"> · {parsed.warning}, corrette</span>}
                    </span>
                )}
                {parsed && !parsed.ok && <span className="text-rose-600">{parsed.error}</span>}
            </div>
        </div>
    );
}

// Name / street / coordinates of a stop, as the dataset stores it. Used by the
// review window's side panel and by "Aggiungi" in the Database tab.
export default function NewStopForm({ initial = {}, submitLabel = 'Aggiungi', busy = false, onSubmit, onCancel }) {
    const [form, setForm] = useState({ name: initial.name ?? '', address: initial.address ?? '', coords: initial.coords ?? '' });
    const parsed = parseCoordinates(form.coords);
    const canSubmit = form.name.trim() && form.address.trim() && parsed.ok && !busy;

    return (
        <div className="space-y-4">
            <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-600">Nome fermata</span>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus={!initial.name}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-600">Via</span>
                <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                    placeholder="es. Rovereto, Corso Bettini 67"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                <span className="mt-1 block text-xs text-slate-400">{STREET_HINT}</span>
            </label>
            <div>
                <span className="mb-1 block text-xs font-semibold text-slate-600">Cerca il luogo <span className="font-normal text-slate-400">(riempie le coordinate)</span></span>
                <AddressAutocomplete
                    value={form.search ?? ''}
                    onChange={v => setForm(f => ({ ...f, search: v }))}
                    onSelect={({ lat, lon }) => setForm(f => ({ ...f, coords: formatCoordinates(+lat.toFixed(7), +lon.toFixed(7)) }))}
                    placeholder="es. Palazzetto dello sport Rovereto"
                />
            </div>
            <div>
                <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600">Coordinate</span>
                    <a href={googleMapsUrl(`${form.address} ${form.name}`.trim() || 'Trentino')} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
                        Cerca su Google Maps <ExternalLink className="h-3 w-3" />
                    </a>
                </div>
                <CoordinateField value={form.coords} onChange={v => setForm(f => ({ ...f, coords: v }))} />
            </div>
            <div className="flex gap-2">
                {onCancel && (
                    <button onClick={onCancel} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">Annulla</button>
                )}
                <button
                    disabled={!canSubmit}
                    onClick={() => onSubmit({ name: form.name.trim(), address: form.address.trim(), lat: parsed.lat, lon: parsed.lon })}
                    className="flex-1 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                >
                    {submitLabel}
                </button>
            </div>
        </div>
    );
}

// The same form in a small window (Database tab, "Aggiungi")
export function NewStopDialog({ title = 'Nuova fermata', busy, onSubmit, onClose }) {
    return createPortal(
        <div className="sr-backdrop-in fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
            <div className="sr-window-in w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex items-start justify-between border-b border-slate-100 px-6 py-4">
                    <div>
                        <h3 className="text-[16px] font-semibold text-slate-900">{title}</h3>
                        <p className="mt-0.5 text-sm text-slate-500">Nome, via e coordinate, come nell'Excel del database.</p>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>
                </div>
                <div className="px-6 py-5">
                    <NewStopForm submitLabel={busy ? 'Salvataggio…' : 'Aggiungi al database'} busy={busy} onSubmit={onSubmit} onCancel={onClose} />
                </div>
            </div>
        </div>,
        document.body,
    );
}
