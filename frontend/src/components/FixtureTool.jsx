import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import AddressAutocomplete from './AddressAutocomplete';
import { getInstituteColorMap } from '../utils/colors';
import API_BASE_URL from '../config';

// ─── Pin icon ────────────────────────────────────────────────────────────────

const _iconCache = new Map();

function makePin(color, selected = false) {
    const key = `${color}-${selected}`;
    if (_iconCache.has(key)) return _iconCache.get(key);
    const size = selected ? 36 : 28;
    const border = selected ? '3px solid white' : '2px solid white';
    const shadow = selected
        ? '0 0 0 3px rgba(59,130,246,0.6), 0 3px 10px rgba(0,0,0,0.35)'
        : '0 2px 8px rgba(0,0,0,0.25)';
    const html = `<div style="
        width:${size}px;height:${size}px;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        background:${color};
        border:${border};
        box-shadow:${shadow};
    "></div>`;
    const icon = L.divIcon({
        html,
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size],
        popupAnchor: [0, -size],
    });
    _iconCache.set(key, icon);
    return icon;
}

// ─── Auto-fit map bounds ──────────────────────────────────────────────────────

function FitBounds({ stops }) {
    const map = useMap();
    useEffect(() => {
        const valid = stops.filter(s => s.lat != null && s.lon != null);
        if (!valid.length) return;
        const bounds = L.latLngBounds(valid.map(s => [s.lat, s.lon]));
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
    }, [stops, map]);
    return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FixtureTool() {
    const [fixtures,    setFixtures]    = useState([]);
    const [search,      setSearch]      = useState('');
    const [selected,    setSelected]    = useState(null);
    const [data,        setData]        = useState(null);
    const [loading,     setLoading]     = useState(false);
    const [editingIdx,  setEditingIdx]  = useState(null);
    const [editAddress, setEditAddress] = useState('');
    const [editCoords,  setEditCoords]  = useState(null);
    const [saving,      setSaving]      = useState(false);
    const [saveError,   setSaveError]   = useState(null);
    const [rebuilding,  setRebuilding]  = useState(false);
    const [rebuildMsg,  setRebuildMsg]  = useState(null);
    const [suggestions, setSuggestions] = useState([]);

    const loadFixtures = () => {
        fetch(`${API_BASE_URL}/api/fixtures`)
            .then(r => r.json())
            .then(d => setFixtures(d.fixtures || []))
            .catch(err => console.error('fixtures list:', err));
    };

    useEffect(() => { loadFixtures(); }, []);

    useEffect(() => {
        if (!selected) { setData(null); return; }
        setLoading(true);
        setEditingIdx(null);
        setRebuildMsg(null);
        fetch(`${API_BASE_URL}/api/fixtures/${encodeURIComponent(selected)}`)
            .then(r => r.json())
            .then(setData)
            .catch(err => console.error('fixture data:', err))
            .finally(() => setLoading(false));
    }, [selected]);

    const colorMap = React.useMemo(() => {
        if (!data) return {};
        return getInstituteColorMap(data.stops.map(s => s.institute).filter(Boolean));
    }, [data]);

    const pinColor = useCallback(stop =>
        (stop.institute && colorMap[stop.institute]) ? colorMap[stop.institute] : '#6b7280',
    [colorMap]);

    const fetchSuggestions = useCallback(async (stopName, currentAddress) => {
        if (!stopName) { setSuggestions([]); return; }
        try {
            const resp = await fetch(
                `${API_BASE_URL}/api/school_cache/suggest?name=${encodeURIComponent(stopName)}&address=${encodeURIComponent(currentAddress || '')}`
            );
            const d = await resp.json();
            setSuggestions(d.suggestions || []);
        } catch {
            setSuggestions([]);
        }
    }, []);

    const startEdit = stop => {
        setEditingIdx(stop.idx);
        setEditAddress(stop.address);
        setEditCoords(stop.lat != null ? { lat: stop.lat, lon: stop.lon } : null);
        setSaveError(null);
        setSuggestions([]);
        fetchSuggestions(stop.name, stop.address);
    };

    const cancelEdit = () => {
        setEditingIdx(null);
        setEditAddress('');
        setEditCoords(null);
        setSaveError(null);
        setSuggestions([]);
    };

    const saveEdit = async stop => {
        if (!editCoords?.lat) {
            setSaveError('Seleziona un indirizzo dal menu a tendina per ottenere le coordinate.');
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            const resp = await fetch(
                `${API_BASE_URL}/api/fixtures/${encodeURIComponent(selected)}/stops/${stop.idx}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: editAddress, lat: editCoords.lat, lon: editCoords.lon }),
                }
            );
            if (!resp.ok) throw new Error((await resp.json()).error || 'Errore sconosciuto');
            setData(prev => ({
                ...prev,
                stops: prev.stops.map(s =>
                    s.idx === stop.idx
                        ? { ...s, address: editAddress, lat: editCoords.lat, lon: editCoords.lon }
                        : s
                ),
            }));
            cancelEdit();
        } catch (err) {
            setSaveError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const rebuildMatrices = async () => {
        if (!selected) return;
        setRebuilding(true);
        setRebuildMsg(null);
        try {
            const resp = await fetch(
                `${API_BASE_URL}/api/fixtures/${encodeURIComponent(selected)}/rebuild_matrices`,
                { method: 'POST' }
            );
            const result = await resp.json();
            if (!resp.ok) throw new Error(result.error || 'Errore sconosciuto');
            setRebuildMsg(
                result.geocoded_new > 0
                    ? `Matrici aggiornate. ${result.geocoded_new} fermate geocodificate, ${result.total - result.geocoded_new} usavano coordinate già presenti.`
                    : `Matrici aggiornate (${result.total} fermate, coordinate già complete).`
            );
            // Refresh fixture data and fixtures list (geocoded flag may have changed)
            loadFixtures();
            const dataResp = await fetch(`${API_BASE_URL}/api/fixtures/${encodeURIComponent(selected)}`);
            setData(await dataResp.json());
        } catch (err) {
            setRebuildMsg(`Errore: ${err.message}`);
        } finally {
            setRebuilding(false);
        }
    };

    const filtered = fixtures.filter(f =>
        (f.name || f).toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="flex flex-col gap-4">

            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-gray-700">Seleziona fixture</label>
                <input
                    type="text"
                    placeholder="Cerca fixture..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <div className="max-h-44 overflow-y-auto border border-gray-200 rounded-lg bg-white">
                    {filtered.length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-400 italic">Nessun risultato</div>
                    )}
                    {filtered.map(f => {
                        const name = f.name || f;
                        const geocoded = f.geocoded ?? false;
                        return (
                            <button
                                key={name}
                                onClick={() => setSelected(name)}
                                className={`w-full text-left px-3 py-2 text-sm border-b border-gray-50 last:border-0 transition-colors flex items-center gap-2
                                    ${selected === name
                                        ? 'bg-blue-100 font-medium text-blue-700'
                                        : 'text-gray-700 hover:bg-blue-50'}`}
                            >
                                <span
                                    className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-xs"
                                    style={{ backgroundColor: geocoded ? '#22c55e' : '#f59e0b', color: 'white' }}
                                    title={geocoded ? 'Tutte le fermate geocodificate' : 'Coordinate mancanti'}
                                >
                                    {geocoded ? '✓' : '!'}
                                </span>
                                <span className="truncate">{name}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {loading && <div className="text-sm text-gray-400 animate-pulse">Caricamento fermate...</div>}

            {data && !loading && (
                <>
                    <div className="flex items-center gap-3">
                        <div className="flex-1 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                            <span className="font-semibold">Destinazione:</span> {data.config?.destination || '—'}
                            {' · '}
                            <span className="font-semibold">Capacità:</span> {data.config?.capacity || '—'}
                            {' · '}
                            <span className="font-semibold">Fermate:</span> {data.stops.length}
                            {' · '}
                            <span className="font-semibold text-amber-600">
                                Senza coordinate: {data.stops.filter(s => s.lat == null).length}
                            </span>
                        </div>
                        <button
                            onClick={rebuildMatrices}
                            disabled={rebuilding}
                            className="flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors whitespace-nowrap"
                            title="Ricalcola time_matrix e distance_matrix dalle coordinate attuali"
                        >
                            {rebuilding ? 'Aggiornamento...' : 'Aggiorna matrici'}
                        </button>
                    </div>
                    {rebuildMsg && (
                        <div className={`text-xs px-3 py-1.5 rounded-lg ${rebuildMsg.startsWith('Errore') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
                            {rebuildMsg}
                        </div>
                    )}

                    <div className="flex gap-4" style={{ minHeight: 520 }}>

                        <div className="w-80 flex-shrink-0 flex flex-col gap-1 overflow-y-auto max-h-[580px] pr-1">
                            {data.stops.map(stop => {
                                const isEditing = editingIdx === stop.idx;
                                const color = pinColor(stop);
                                const missingCoords = stop.lat == null;
                                return (
                                    <div
                                        key={stop.idx}
                                        className={`rounded-lg border transition-all ${
                                            isEditing
                                                ? 'border-blue-400 bg-blue-50 shadow-md'
                                                : missingCoords
                                                    ? 'border-amber-300 bg-amber-50'
                                                    : 'border-gray-200 bg-white hover:border-gray-300'
                                        }`}
                                    >
                                        <button
                                            className="w-full text-left px-3 py-2 flex items-start gap-2"
                                            onClick={() => isEditing ? cancelEdit() : startEdit(stop)}
                                        >
                                            <span
                                                className="mt-1 w-3 h-3 rounded-full flex-shrink-0"
                                                style={{ backgroundColor: missingCoords ? '#f59e0b' : color }}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium text-gray-900 truncate">{stop.name}</div>
                                                <div className="text-xs text-gray-500 truncate">{stop.address}</div>
                                                {stop.institute && (
                                                    <div className="text-xs text-gray-400 truncate">{stop.institute}</div>
                                                )}
                                            </div>
                                            <span className="text-xs font-bold text-gray-500 flex-shrink-0 mt-0.5">
                                                {stop.participants}
                                            </span>
                                        </button>

                                        {isEditing && (
                                            <div className="px-3 pb-3 flex flex-col gap-2 border-t border-blue-200 pt-2">
                                                <div className="text-xs font-semibold text-gray-600">
                                                    Nuovo indirizzo per{' '}
                                                    <span className="text-blue-600">{stop.name}</span>
                                                </div>
                                                <AddressAutocomplete
                                                    value={editAddress}
                                                    onChange={setEditAddress}
                                                    onSelect={({ address, lat, lon }) => {
                                                        setEditAddress(address);
                                                        setEditCoords({ lat, lon });
                                                    }}
                                                    placeholder="Cerca nuovo indirizzo..."
                                                />
                                                {suggestions.length > 0 && (
                                                    <div className="flex flex-col gap-1">
                                                        <div className="text-xs text-gray-400">Forse intendi uno di questi?</div>
                                                        {suggestions.map((s, i) => (
                                                            <button
                                                                key={i}
                                                                type="button"
                                                                onClick={() => {
                                                                    setEditAddress(s.address);
                                                                    if (s.lat != null) setEditCoords({ lat: s.lat, lon: s.lon });
                                                                    setSuggestions([]);
                                                                }}
                                                                className="text-left text-xs px-2 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 transition-colors"
                                                            >
                                                                {s.name !== stop.name && (
                                                                    <span className="font-medium text-blue-500 mr-1">{s.name}:</span>
                                                                )}
                                                                {s.address}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {editCoords?.lat != null && (
                                                    <div className="text-xs text-green-600 font-mono">
                                                        {editCoords.lat.toFixed(5)}, {editCoords.lon.toFixed(5)}
                                                    </div>
                                                )}
                                                {saveError && (
                                                    <div className="text-xs text-red-500">{saveError}</div>
                                                )}
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => saveEdit(stop)}
                                                        disabled={saving}
                                                        className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors"
                                                    >
                                                        {saving ? 'Salvataggio...' : 'Salva'}
                                                    </button>
                                                    <button
                                                        onClick={cancelEdit}
                                                        className="px-3 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold py-1.5 rounded-lg transition-colors"
                                                    >
                                                        Annulla
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        <div
                            className="flex-1 rounded-xl overflow-hidden border border-gray-200"
                            style={{ minHeight: 520 }}
                        >
                            <MapContainer
                                center={[46.07, 11.12]}
                                zoom={9}
                                style={{ width: '100%', height: '100%', minHeight: 520 }}
                            >
                                <TileLayer
                                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                />
                                <FitBounds stops={data.stops} />
                                {data.stops.map(stop => {
                                    if (stop.lat == null || stop.lon == null) return null;
                                    const color = pinColor(stop);
                                    const isEditing = editingIdx === stop.idx;
                                    return (
                                        <Marker
                                            key={stop.idx}
                                            position={[stop.lat, stop.lon]}
                                            icon={makePin(color, isEditing)}
                                            eventHandlers={{
                                                click: () => isEditing ? cancelEdit() : startEdit(stop),
                                            }}
                                        >
                                            <Popup>
                                                <strong>{stop.name}</strong><br />
                                                {stop.address}<br />
                                                {stop.participants} partecipanti
                                            </Popup>
                                        </Marker>
                                    );
                                })}
                            </MapContainer>
                        </div>
                    </div>

                    <div className="text-xs text-gray-400 italic">
                        Dopo aver corretto gli indirizzi, usa <strong>Aggiorna matrici</strong> per ricalcolare time_matrix e distance_matrix.
                    </div>
                </>
            )}
        </div>
    );
}
