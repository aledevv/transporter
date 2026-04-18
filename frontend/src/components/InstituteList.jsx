import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Pencil, Trash2, Check, X, AlertTriangle } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';
import API_BASE_URL from '../config';
import { collection, getDocs, setDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';

// ─── Pin icon ─────────────────────────────────────────────────────────────────

const _iconCache = new Map();
function makePin(color, selected = false) {
    const key = `${color}-${selected}`;
    if (_iconCache.has(key)) return _iconCache.get(key);
    const size = selected ? 30 : 20;
    const html = `<div style="
        width:${size}px;height:${size}px;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        background:${color};
        border:2px solid white;
        box-shadow:${selected
            ? '0 0 0 3px rgba(59,130,246,0.6),0 2px 8px rgba(0,0,0,0.3)'
            : '0 1px 5px rgba(0,0,0,0.25)'};
    "></div>`;
    const icon = L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size], popupAnchor: [0, -size] });
    _iconCache.set(key, icon);
    return icon;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

// Only fit bounds once on first valid load — never again (prevents gray flash on re-renders)
function FitAll({ points }) {
    const map = useMap();
    const fittedRef = useRef(false);
    useEffect(() => {
        if (fittedRef.current) return;
        const valid = points.filter(p => p.lat != null && p.lon != null);
        if (!valid.length) return;
        const bounds = L.latLngBounds(valid.map(p => [p.lat, p.lon]));
        if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [30, 30] });
            fittedRef.current = true;
        }
    }, [points, map]);
    return null;
}

function FlyTo({ target }) {
    const map = useMap();
    const prevRef = useRef(null);
    useEffect(() => {
        if (!target) return;
        const key = `${target.lat},${target.lon}`;
        if (prevRef.current === key) return;   // same target, don't re-fly
        prevRef.current = key;
        map.flyTo([target.lat, target.lon], 13, { duration: 0.7 });
    }, [target, map]);
    return null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const eKey = (name, address) => `${name}||${address}`;

const makeStableId = (name, address) =>
    btoa(unescape(encodeURIComponent(`${name}||${address}`))).replace(/[/+=]/g, '_');

// Reconstruct nested institute format from flat Firestore docs
function firestoreDocsToInstitutes(docs) {
    const map = new Map();
    for (const d of docs) {
        const { id: docId, name, address, lat, lon } = d;
        if (!map.has(name)) map.set(name, []);
        map.get(name).push({ address, lat, lon, fixture_count: 1, _docId: docId });
    }
    const result = [];
    map.forEach((entries, name) => result.push({ name, entries }));
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InstituteList({ db }) {
    const [institutes, setInstitutes] = useState([]);
    const [loading,    setLoading]    = useState(true);
    const [search,     setSearch]     = useState('');
    const [highlighted, setHighlighted] = useState(null); // {name, address, lat, lon}
    const [firestoreCount, setFirestoreCount] = useState(null); // null = unknown, number = known

    // Edit state
    const [editingKey, setEditingKey]   = useState(null);
    const [editForm,   setEditForm]     = useState({ name: '', address: '', lat: null, lon: null });
    const [mergeConflict, setMergeConflict] = useState(null); // {conflict:{name,address,fixture_count}, oldName, oldAddress}
    const [saving,     setSaving]       = useState(false);

    // Delete state
    const [deleteKey,  setDeleteKey]    = useState(null);
    const [deleting,   setDeleting]     = useState(false);

    const [statusMsg,  setStatusMsg]    = useState(null); // {type:'ok'|'err', text}
    const [syncing,    setSyncing]      = useState(false);

    // Load from Firestore if db available, otherwise fallback to API
    const loadFromFirestore = async () => {
        const snap = await getDocs(collection(db, 'institutes'));
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setFirestoreCount(docs.length);
        if (docs.length > 0) {
            setInstitutes(firestoreDocsToInstitutes(docs));
        }
        return docs.length;
    };

    const loadFromApi = () => {
        return fetch(`${API_BASE_URL}/api/fixtures/institutes`)
            .then(r => r.json())
            .then(d => {
                setInstitutes(d.institutes || []);
            });
    };

    const load = () => {
        setLoading(true);
        if (db) {
            loadFromFirestore()
                .then(count => {
                    if (count === 0) {
                        // Firestore empty — also load from API so list isn't blank
                        return loadFromApi();
                    }
                })
                .catch(() => loadFromApi())
                .finally(() => setLoading(false));
        } else {
            loadFromApi()
                .catch(() => {})
                .finally(() => setLoading(false));
        }
    };

    useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Sync all institutes from fixtures API into Firestore
    const handleSyncFromFixtures = async () => {
        if (!db) return;
        setSyncing(true);
        setStatusMsg(null);
        try {
            const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes`);
            const data = await resp.json();
            const apiInstitutes = data.institutes || [];
            const col = collection(db, 'institutes');
            const writes = [];
            for (const inst of apiInstitutes) {
                for (const entry of inst.entries) {
                    const stableId = makeStableId(inst.name, entry.address);
                    writes.push(
                        setDoc(doc(col, stableId), {
                            name: inst.name,
                            address: entry.address,
                            lat: entry.lat ?? null,
                            lon: entry.lon ?? null,
                            updatedAt: serverTimestamp(),
                        })
                    );
                }
            }
            await Promise.all(writes);
            setStatusMsg({ type: 'ok', text: `Sincronizzati ${writes.length} istituti da Fixture.` });
            // Reload from Firestore
            setLoading(true);
            const count = await loadFromFirestore();
            if (count === 0) await loadFromApi();
        } catch (err) {
            setStatusMsg({ type: 'err', text: `Errore sincronizzazione: ${err.message}` });
            try {
                await loadFromFirestore();
            } catch { /* best effort */ }
        } finally {
            setSyncing(false);
            setLoading(false);
        }
    };

    // Memoize flat points list so FitAll/markers don't re-trigger on every click
    const allPoints = useMemo(() =>
        institutes.flatMap(inst =>
            inst.entries
                .filter(e => e.lat != null)
                .map(e => ({ name: inst.name, address: e.address, lat: e.lat, lon: e.lon, fixture_count: e.fixture_count }))
        ), [institutes]);

    const filtered = useMemo(() =>
        institutes.filter(inst =>
            inst.name.toLowerCase().includes(search.toLowerCase()) ||
            inst.entries.some(e => e.address.toLowerCase().includes(search.toLowerCase()))
        ), [institutes, search]);

    const handleSelect = (name, entry) => {
        if (!entry.lat) return;
        setHighlighted(prev =>
            prev && prev.name === name && prev.address === entry.address
                ? null
                : { name, address: entry.address, lat: entry.lat, lon: entry.lon }
        );
    };

    const startEdit = (instName, entry) => {
        setEditingKey(eKey(instName, entry.address));
        setEditForm({ name: instName, address: entry.address, lat: entry.lat, lon: entry.lon });
        setDeleteKey(null);
        setMergeConflict(null);
        setStatusMsg(null);
    };

    const cancelEdit = () => { setEditingKey(null); setMergeConflict(null); };

    const handleSave = async (oldName, oldAddress, forceMerge = false) => {
        setSaving(true);
        setMergeConflict(null);
        try {
            const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name:    oldName,
                    old_address: oldAddress,
                    new_name:    editForm.name.trim(),
                    new_address: editForm.address.trim(),
                    new_lat:     editForm.lat,
                    new_lon:     editForm.lon,
                    force_merge: forceMerge,
                }),
            });
            const result = await resp.json();
            if (!resp.ok) throw new Error(result.error || 'Errore sconosciuto');
            if (result.conflict) {
                setMergeConflict({ conflict: result.conflict, oldName, oldAddress });
                return;
            }

            // Sync edit to Firestore
            if (db) {
                try {
                    // Find entry with _docId
                    const entry = institutes
                        .find(i => i.name === oldName)
                        ?.entries.find(e => e.address === oldAddress);
                    const firestoreId = entry?._docId || makeStableId(oldName, oldAddress);
                    await setDoc(
                        doc(db, 'institutes', firestoreId),
                        {
                            name: editForm.name.trim(),
                            address: editForm.address.trim(),
                            lat: editForm.lat ?? null,
                            lon: editForm.lon ?? null,
                            updatedAt: serverTimestamp(),
                        }
                    );
                } catch (err) {
                    console.warn('[InstituteList] Firestore sync failed on save:', err);
                }
            }

            setStatusMsg({ type: 'ok', text: `Aggiornato in ${result.modified.length} fixture.` });
            cancelEdit();
            load();
        } catch (err) {
            setStatusMsg({ type: 'err', text: err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (name, address) => {
        setDeleting(true);
        try {
            // Find _docId before API call (state still intact)
            const entry = institutes
                .find(i => i.name === name)
                ?.entries.find(e => e.address === address);

            const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, address }),
            });
            const result = await resp.json();
            if (!resp.ok) throw new Error(result.error || 'Errore sconosciuto');

            // Sync delete to Firestore
            if (db && entry?._docId) {
                try {
                    await deleteDoc(doc(db, 'institutes', entry._docId));
                } catch (err) {
                    console.warn('[InstituteList] Firestore sync failed on delete:', err);
                }
            }

            setStatusMsg({ type: 'ok', text: `Rimosso da ${result.modified.length} fixture.` });
            setDeleteKey(null);
            load();
        } catch (err) {
            setStatusMsg({ type: 'err', text: err.message });
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="flex flex-col gap-3">

            {statusMsg && (
                <div
                    className={`text-xs px-3 py-2 rounded-lg flex items-center justify-between ${
                        statusMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
                    }`}
                >
                    {statusMsg.text}
                    <button onClick={() => setStatusMsg(null)} className="ml-2 opacity-60 hover:opacity-100">
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            <div className="flex flex-col gap-3">

                {/* ── Firestore empty: prominent sync button ── */}
                {db && firestoreCount === 0 && !loading && (
                    <div className="flex flex-col items-center gap-2 py-4 bg-blue-50 rounded-xl border border-blue-200">
                        <p className="text-sm text-blue-700">
                            La collezione Firestore è vuota. Sincronizza i dati dai fixture.
                        </p>
                        <button
                            onClick={handleSyncFromFixtures}
                            disabled={syncing}
                            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg shadow"
                        >
                            {syncing ? 'Sincronizzazione...' : 'Sincronizza da Fixture'}
                        </button>
                    </div>
                )}

                <div className="flex gap-4" style={{ minHeight: 560 }}>

                    {/* ── Left panel ──────────────────────────────────────────── */}
                    <div className="w-[420px] flex-shrink-0 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                placeholder="Cerca istituto o indirizzo..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            {/* Secondary sync button when Firestore has data */}
                            {db && firestoreCount !== null && firestoreCount > 0 && (
                                <button
                                    onClick={handleSyncFromFixtures}
                                    disabled={syncing || loading}
                                    title="Aggiorna da Fixture"
                                    className="px-2 py-2 text-xs bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-600 rounded-lg border border-gray-200 whitespace-nowrap"
                                >
                                    {syncing ? '...' : 'Aggiorna da Fixture'}
                                </button>
                            )}
                        </div>

                        {!loading && (
                            <div className="text-xs text-gray-400">
                                {filtered.reduce((n, i) => n + i.entries.length, 0)} voci
                                {search ? ` su ${institutes.reduce((n, i) => n + i.entries.length, 0)} totali` : ''}
                            </div>
                        )}
                        {loading && <div className="text-sm text-gray-400 animate-pulse">Caricamento...</div>}

                        <div className="overflow-y-auto flex-1 pr-0.5" style={{ maxHeight: 510 }}>
                            {filtered.map(inst => (
                                <div key={inst.name} className="mb-0.5">
                                    {inst.entries.map((entry, ei) => {
                                        const key     = eKey(inst.name, entry.address);
                                        const isEdit  = editingKey === key;
                                        const isDel   = deleteKey  === key;
                                        const isHL    = highlighted?.name === inst.name && highlighted?.address === entry.address;
                                        const hasPt   = entry.lat != null;

                                        /* ── Edit form ── */
                                        if (isEdit) return (
                                            <div key={ei} className="rounded-lg border border-blue-300 bg-blue-50 p-2 mb-0.5 flex flex-col gap-1.5">
                                                <input
                                                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-400 outline-none"
                                                    placeholder="Nome istituto"
                                                    value={editForm.name}
                                                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                                                />
                                                <AddressAutocomplete
                                                    value={editForm.address}
                                                    onChange={v => setEditForm(f => ({ ...f, address: v, lat: null, lon: null }))}
                                                    onSelect={({ address, lat, lon }) =>
                                                        setEditForm(f => ({ ...f, address, lat, lon }))
                                                    }
                                                    placeholder="Indirizzo..."
                                                />
                                                {editForm.lat != null && (
                                                    <div className="text-xs text-green-600 font-mono">
                                                        {editForm.lat.toFixed(5)}, {editForm.lon.toFixed(5)}
                                                    </div>
                                                )}
                                                {/* Merge conflict prompt */}
                                                {mergeConflict && mergeConflict.oldName === inst.name && mergeConflict.oldAddress === entry.address && (
                                                    <div className="flex flex-col gap-1 bg-amber-50 border border-amber-300 rounded-lg px-2 py-1.5">
                                                        <div className="flex items-start gap-1 text-xs text-amber-700">
                                                            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                                            <span>
                                                                Questo indirizzo è già usato da{' '}
                                                                <strong>{mergeConflict.conflict.name}</strong>
                                                                {' '}in{' '}{mergeConflict.conflict.fixture_count} fixture.
                                                                Vuoi unire le due voci?
                                                            </span>
                                                        </div>
                                                        <div className="flex gap-1">
                                                            <button
                                                                onClick={() => handleSave(inst.name, entry.address, true)}
                                                                disabled={saving}
                                                                className="flex-1 text-xs bg-amber-600 hover:bg-amber-700 text-white py-1 rounded-md disabled:opacity-50"
                                                            >
                                                                Unisci
                                                            </button>
                                                            <button
                                                                onClick={() => setMergeConflict(null)}
                                                                className="px-3 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 rounded-md"
                                                            >
                                                                Annulla
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => handleSave(inst.name, entry.address)}
                                                        disabled={saving || !editForm.name.trim() || !editForm.address.trim()}
                                                        className="flex-1 flex items-center justify-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-1 rounded-md"
                                                    >
                                                        <Check className="w-3 h-3" />
                                                        {saving ? 'Salvataggio...' : 'Salva'}
                                                    </button>
                                                    <button
                                                        onClick={cancelEdit}
                                                        className="px-3 flex items-center gap-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 rounded-md"
                                                    >
                                                        <X className="w-3 h-3" /> Annulla
                                                    </button>
                                                </div>
                                            </div>
                                        );

                                        /* ── Delete confirm ── */
                                        if (isDel) return (
                                            <div key={ei} className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 mb-0.5 flex flex-col gap-1.5">
                                                <div className="text-xs text-red-700">
                                                    Rimuovere <strong>{inst.name}</strong> da{' '}
                                                    <strong>{entry.fixture_count}</strong> fixture?
                                                    <span className="block text-gray-500 mt-0.5 font-normal">{entry.address}</span>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => handleDelete(inst.name, entry.address)}
                                                        disabled={deleting}
                                                        className="flex-1 text-xs bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white py-1 rounded-md"
                                                    >
                                                        {deleting ? 'Rimozione...' : 'Sì, rimuovi'}
                                                    </button>
                                                    <button
                                                        onClick={() => setDeleteKey(null)}
                                                        className="px-3 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 rounded-md"
                                                    >
                                                        Annulla
                                                    </button>
                                                </div>
                                            </div>
                                        );

                                        /* ── Normal row ── */
                                        return (
                                            <div
                                                key={ei}
                                                onClick={() => handleSelect(inst.name, entry)}
                                                className={`group px-2 py-1.5 rounded-lg border transition-all flex items-center gap-2 mb-0.5 ${
                                                    isHL
                                                        ? 'border-blue-400 bg-blue-50'
                                                        : hasPt
                                                            ? 'border-gray-100 bg-white hover:border-gray-300'
                                                            : 'border-amber-100 bg-amber-50/50 hover:border-amber-200'
                                                } ${hasPt ? 'cursor-pointer' : 'cursor-default'}`}
                                            >
                                                <span
                                                    className="w-2 h-2 rounded-full flex-shrink-0"
                                                    style={{ backgroundColor: hasPt ? '#22c55e' : '#f59e0b' }}
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-xs font-semibold text-gray-800 truncate leading-tight">
                                                        {inst.name}
                                                        {inst.entries.length > 1 && (
                                                            <span className="ml-1 text-gray-400 font-normal">
                                                                ({ei + 1}/{inst.entries.length})
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-gray-500 truncate leading-tight">{entry.address}</div>
                                                </div>
                                                {entry.fixture_count > 1 && (
                                                    <span className="text-xs text-gray-400 flex-shrink-0">×{entry.fixture_count}</span>
                                                )}
                                                {/* Action buttons — visible on hover */}
                                                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                                    <button
                                                        onClick={e => { e.stopPropagation(); startEdit(inst.name, entry); }}
                                                        className="p-1 rounded hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                                                        title="Modifica"
                                                    >
                                                        <Pencil className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                        onClick={e => { e.stopPropagation(); setDeleteKey(key); setEditingKey(null); }}
                                                        className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600"
                                                        title="Elimina"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                            {!loading && filtered.length === 0 && (
                                <div className="text-sm text-gray-400 italic px-2">Nessun risultato</div>
                            )}
                        </div>
                    </div>

                    {/* ── Right: map ──────────────────────────────────────────── */}
                    <div className="flex-1 rounded-xl overflow-hidden border border-gray-200" style={{ minHeight: 560 }}>
                        <MapContainer
                            center={[46.07, 11.12]}
                            zoom={8}
                            style={{ width: '100%', height: '100%', minHeight: 560 }}
                        >
                            <TileLayer
                                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            />
                            <FitAll points={allPoints} />
                            {highlighted && <FlyTo target={highlighted} />}
                            {allPoints.map((pt, i) => {
                                const isHL = highlighted?.name === pt.name && highlighted?.address === pt.address;
                                return (
                                    <Marker
                                        key={i}
                                        position={[pt.lat, pt.lon]}
                                        icon={makePin(isHL ? '#3b82f6' : '#6b7280', isHL)}
                                        zIndexOffset={isHL ? 1000 : 0}
                                        eventHandlers={{ click: () => handleSelect(pt.name, pt) }}
                                    >
                                        <Popup>
                                            <strong>{pt.name}</strong><br />
                                            {pt.address}
                                            {pt.fixture_count > 1 && (
                                                <><br /><span style={{ color: '#6b7280', fontSize: '0.75em' }}>×{pt.fixture_count} eventi</span></>
                                            )}
                                        </Popup>
                                    </Marker>
                                );
                            })}
                        </MapContainer>
                    </div>
                </div>
            </div>
        </div>
    );
}
