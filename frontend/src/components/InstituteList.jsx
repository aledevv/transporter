import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Pencil, Trash2, Check, X, AlertTriangle, MoreVertical, ArrowRightLeft } from 'lucide-react';
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

const eKey = (name, address, id) => `${name}||${address}||${id}`;

const makeStableId = (name, address) =>
    btoa(unescape(encodeURIComponent(`${name}||${address}`))).replace(/[/+=]/g, '_');

// Reconstruct nested institute format from flat Firestore docs
function firestoreDocsToInstitutes(docs) {
    const map = new Map();
    for (const d of docs) {
        let { id: docId, name, address, lat, lon, type, description, originalName } = d;
        let cleanName = name || '';
        let desc = description || '';

        if (description === undefined && cleanName.includes('(')) {
            const m = cleanName.match(/\((.*?)\)/);
            if (m) {
                desc = m[1].replace(/["']/g, '').trim();
                cleanName = cleanName.replace(/\(.*?\)/g, '').replace(/["']/g, '').trim();
            }
        }
        cleanName = cleanName.trim();

        if (!map.has(cleanName)) map.set(cleanName, []);
        const defaultType = /(ic\b|istituto|scuola|liceo|polo|primaria|secondaria)/i.test(cleanName) ? 'istituto' : 'destinazione';
        map.get(cleanName).push({ 
            address, lat, lon, fixture_count: 1, _docId: docId, 
            type: type || defaultType, 
            description: desc,
            originalName: originalName || name 
        });
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
    const [activeTab, setActiveTab] = useState('istituto'); // 'istituto' or 'destinazione'
    const [menuOpen, setMenuOpen] = useState(false);

    // Edit state
    const [editingKey, setEditingKey]   = useState(null);
    const [editForm,   setEditForm]     = useState({ name: '', description: '', address: '', lat: null, lon: null, originalName: '' });
    const [mergeConflict, setMergeConflict] = useState(null); // {conflict:{name,address,fixture_count}, oldName, oldAddress}
    const [saving,     setSaving]       = useState(false);

    // Delete state
    const [deleteKey,  setDeleteKey]    = useState(null);
    const [deleting,   setDeleting]     = useState(false);

    // Multi-select state
    const [multiSelectMode, setMultiSelectMode] = useState(false);
    const [selectedKeys,    setSelectedKeys]    = useState(new Set()); // Set of uniqueId
    const [dragState, setDragState] = useState(null); // { startIndex, currentIndex, initialSelected: Set, action: 'select' | 'deselect' }

    // Stop drag selection on mouse up/touch end anywhere
    useEffect(() => {
        const handlePointerUp = () => {
            setDragState(null);
        };
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('touchend', handlePointerUp);
        return () => {
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('touchend', handlePointerUp);
        };
    }, []);

    const [animatingDeletes, setAnimatingDeletes] = useState(new Set());
    const [animatingMoves, setAnimatingMoves] = useState(new Set());
    const timerRef = useRef(null);
    const ignoreNextClickRef = useRef(false);
    const pointerStartPosRef = useRef(null);

    // Add state
    const [isAdding,   setIsAdding]     = useState(false);
    const [addForm,    setAddForm]      = useState({ name: '', description: '', address: '', lat: null, lon: null });

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
                const apiInsts = d.institutes || [];
                const map = new Map();
                apiInsts.forEach(inst => {
                    let cleanName = inst.name || '';
                    let desc = '';
                    if (cleanName.includes('(')) {
                        const m = cleanName.match(/\((.*?)\)/);
                        if (m) {
                            desc = m[1].replace(/["']/g, '').trim();
                            cleanName = cleanName.replace(/\(.*?\)/g, '').replace(/["']/g, '').trim();
                        }
                    }
                    cleanName = cleanName.trim();
                    if (!map.has(cleanName)) map.set(cleanName, []);
                    const defaultType = /(ic\b|istituto|scuola|liceo|polo|primaria|secondaria)/i.test(cleanName) ? 'istituto' : 'destinazione';
                    
                    inst.entries.forEach(e => {
                        map.get(cleanName).push({
                            ...e,
                            type: defaultType,
                            description: desc,
                            originalName: inst.name,
                            _docId: null
                        });
                    });
                });
                
                const result = [];
                map.forEach((entries, name) => result.push({ name, entries }));
                result.sort((a, b) => a.name.localeCompare(b.name));
                setInstitutes(result);
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

    // Cancel multi-select on Escape key
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' && multiSelectMode) {
                setMultiSelectMode(false);
                setSelectedKeys(new Set());
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [multiSelectMode]);


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
                    let cleanName = inst.name || '';
                    let desc = '';
                    if (cleanName.includes('(')) {
                        const m = cleanName.match(/\((.*?)\)/);
                        if (m) {
                            desc = m[1].replace(/["']/g, '').trim();
                            cleanName = cleanName.replace(/\(.*?\)/g, '').replace(/["']/g, '').trim();
                        }
                    }
                    cleanName = cleanName.trim();
                    const stableId = makeStableId(inst.name, entry.address);
                    writes.push(
                        setDoc(doc(col, stableId), {
                            name: cleanName,
                            originalName: inst.name,
                            description: desc,
                            address: entry.address,
                            lat: entry.lat ?? null,
                            lon: entry.lon ?? null,
                            updatedAt: serverTimestamp(),
                        }, { merge: true })
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
                .map((e, ei) => ({ ...e, originalIndex: ei }))
                .filter(e => e.lat != null && e.type === activeTab)
                .map(e => ({ name: inst.name, address: e.address, lat: e.lat, lon: e.lon, fixture_count: e.fixture_count, uniqueId: e._docId || e.originalIndex }))
        ), [institutes, activeTab]);

    const filtered = useMemo(() => {
        const result = [];
        institutes.forEach(inst => {
            const matchName = inst.name.toLowerCase().includes(search.toLowerCase());
            const filteredEntries = inst.entries.filter(e => {
                if (e.type !== activeTab) return false;
                const matchDesc = e.description && e.description.toLowerCase().includes(search.toLowerCase());
                if (search && !matchName && !matchDesc && !e.address.toLowerCase().includes(search.toLowerCase())) return false;
                return true;
            });
            if (filteredEntries.length > 0) {
                result.push({ ...inst, entries: filteredEntries });
            }
        });
        return result;
    }, [institutes, search, activeTab]);

    const flattenedIds = useMemo(() => {
        const ids = [];
        filtered.forEach(inst => {
            inst.entries.forEach((entry, ei) => {
                ids.push(entry._docId || ei);
            });
        });
        return ids;
    }, [filtered]);

    const toggleSelect = (uniqueId) => {
        setSelectedKeys(prev => {
            const next = new Set(prev);
            if (next.has(uniqueId)) {
                next.delete(uniqueId);
            } else {
                next.add(uniqueId);
            }
            return next;
        });
    };

    const handlePointerDown = (e, uniqueId) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        
        if (multiSelectMode) {
            try {
                if (e.target.hasPointerCapture(e.pointerId)) {
                    e.target.releasePointerCapture(e.pointerId);
                }
            } catch (err) {}
            
            const startIndex = flattenedIds.indexOf(uniqueId);
            if (startIndex === -1) return;
            
            const isCurrentlySelected = selectedKeys.has(uniqueId);
            const action = isCurrentlySelected ? 'deselect' : 'select';
            
            setDragState({
                startIndex,
                currentIndex: startIndex,
                initialSelected: new Set(selectedKeys),
                action
            });
            
            setSelectedKeys(prev => {
                const next = new Set(prev);
                if (action === 'select') next.add(uniqueId);
                else next.delete(uniqueId);
                return next;
            });
            return;
        }

        pointerStartPosRef.current = { x: e.clientX, y: e.clientY };
        timerRef.current = setTimeout(() => {
            setMultiSelectMode(true);
            setSelectedKeys(new Set([uniqueId]));
            ignoreNextClickRef.current = true;
            timerRef.current = null;
        }, 500); // 500ms for long press
    };

    const applyDragRange = (newCurrentIndex, stateObj) => {
        if (!stateObj) return;
        const { startIndex, initialSelected, action } = stateObj;
        const nextKeys = new Set(initialSelected);
        const minIdx = Math.min(startIndex, newCurrentIndex);
        const maxIdx = Math.max(startIndex, newCurrentIndex);
        
        for (let i = minIdx; i <= maxIdx; i++) {
            const id = flattenedIds[i];
            if (action === 'select') nextKeys.add(id);
            else nextKeys.delete(id);
        }
        setSelectedKeys(nextKeys);
    };

    const handlePointerEnterRow = (e, uniqueId) => {
        if (!multiSelectMode || !dragState) return;
        const hoveredIndex = flattenedIds.indexOf(uniqueId);
        if (hoveredIndex !== -1 && hoveredIndex !== dragState.currentIndex) {
            const newState = { ...dragState, currentIndex: hoveredIndex };
            setDragState(newState);
            applyDragRange(hoveredIndex, newState);
        }
    };

    const handlePointerCancelOrMove = (e) => {
        if (!timerRef.current) return;
        
        // If it's a move event, only cancel if moved more than 10px (allow jitter)
        if (e && e.type === 'pointermove' && pointerStartPosRef.current) {
            const dx = e.clientX - pointerStartPosRef.current.x;
            const dy = e.clientY - pointerStartPosRef.current.y;
            if (Math.sqrt(dx * dx + dy * dy) < 10) return;
        }
        
        clearTimeout(timerRef.current);
        timerRef.current = null;
    };

    const handleClick = (e, name, entry, uniqueId) => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        if (ignoreNextClickRef.current) {
            ignoreNextClickRef.current = false;
            return;
        }
        if (multiSelectMode) {
            // Do nothing: handlePointerDown already toggled the item.
        } else {
            handleSelect(name, entry, uniqueId);
        }
    };

    const handleMoveType = async (name, entry, uniqueId) => {
        const newType = activeTab === 'istituto' ? 'destinazione' : 'istituto';
        setAnimatingMoves(prev => new Set(prev).add(uniqueId));
        
        if (db && entry._docId) {
            try {
                await setDoc(doc(db, 'institutes', entry._docId), { type: newType, updatedAt: serverTimestamp() }, { merge: true });
            } catch (err) {
                console.warn('[InstituteList] Firestore sync failed on move:', err);
            }
        }
        
        setTimeout(() => {
            setInstitutes(prev => prev.map(inst => {
                if (inst.name === name) {
                    return {
                        ...inst,
                        entries: inst.entries.map((e, idx) => {
                            if ((e._docId || idx) === uniqueId) return { ...e, type: newType };
                            return e;
                        })
                    };
                }
                return inst;
            }));
            setAnimatingMoves(prev => {
                const next = new Set(prev);
                next.delete(uniqueId);
                return next;
            });
            setStatusMsg({ type: 'ok', text: `Spostato in ${newType === 'istituto' ? 'Istituti' : 'Destinazioni'}.` });
        }, 350);
    };

    const handleBulkMove = async () => {
        if (selectedKeys.size === 0) return;
        const newType = activeTab === 'istituto' ? 'destinazione' : 'istituto';
        
        setDeleting(true);
        const writes = [];
        const uniqueIds = Array.from(selectedKeys);
        
        uniqueIds.forEach(uniqueId => {
            setAnimatingMoves(prev => new Set(prev).add(uniqueId));
            if (db) {
                let targetEntry = null;
                for (const inst of institutes) {
                    const e = inst.entries.find((entry, idx) => (entry._docId || idx) === uniqueId);
                    if (e) { targetEntry = e; break; }
                }
                if (targetEntry && targetEntry._docId) {
                    writes.push(setDoc(doc(db, 'institutes', targetEntry._docId), { type: newType, updatedAt: serverTimestamp() }, { merge: true }));
                }
            }
        });
        
        try {
            if (writes.length > 0) await Promise.all(writes);
            setTimeout(() => {
                setInstitutes(prev => prev.map(inst => ({
                    ...inst,
                    entries: inst.entries.map((e, idx) => {
                        if (selectedKeys.has(e._docId || idx)) return { ...e, type: newType };
                        return e;
                    })
                })));
                setMultiSelectMode(false);
                setSelectedKeys(new Set());
                setAnimatingMoves(new Set());
                setStatusMsg({ type: 'ok', text: `Spostati ${uniqueIds.length} elementi in ${newType === 'istituto' ? 'Istituti' : 'Destinazioni'}.` });
            }, 350);
        } catch (err) {
            setStatusMsg({ type: 'err', text: `Errore durante lo spostamento multiplo.` });
        } finally {
            setDeleting(false);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedKeys.size === 0) {
            setMultiSelectMode(false);
            return;
        }
        const confirm = window.confirm(`Sei sicuro di voler eliminare ${selectedKeys.size} elementi selezionati?`);
        if (!confirm) return;

        setDeleting(true);
        let successCount = 0;
        try {
            for (const uniqueId of Array.from(selectedKeys)) {
                let targetEntry = null;
                let targetInstName = null;
                for (const inst of institutes) {
                    const e = inst.entries.find((entry, idx) => (entry._docId || idx) === uniqueId);
                    if (e) {
                        targetEntry = e;
                        break;
                    }
                }
                if (!targetEntry) continue;

                const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: targetEntry.originalName || targetEntry.name, address: targetEntry.address }),
                });
                
                if (resp.ok) {
                    if (db && targetEntry._docId) {
                        try {
                            await deleteDoc(doc(db, 'institutes', targetEntry._docId));
                        } catch(e) {
                            console.warn('Firestore delete sync failed:', e);
                        }
                    }
                    successCount++;
                    setAnimatingDeletes(prev => new Set(prev).add(uniqueId));
                }
            }
            setStatusMsg({ type: 'ok', text: `Eliminati ${successCount} elementi.` });
            setMultiSelectMode(false);
            setSelectedKeys(new Set());
            setTimeout(() => {
                setAnimatingDeletes(new Set());
                load();
            }, 350);
        } catch(err) {
            setStatusMsg({ type: 'err', text: `Errore durante l'eliminazione multipla.` });
        } finally {
            setDeleting(false);
        }
    };

    const handleSelect = (name, entry, uniqueId) => {
        if (!entry.lat) return;
        setHighlighted(prev =>
            prev && prev.name === name && prev.address === entry.address && prev.uniqueId === uniqueId
                ? null
                : { name, address: entry.address, lat: entry.lat, lon: entry.lon, uniqueId }
        );
    };

    const startEdit = (instName, entry, id) => {
        setEditingKey(eKey(instName, entry.address, id));
        setEditForm({ 
            name: instName, 
            description: entry.description || '', 
            address: entry.address, 
            lat: entry.lat, 
            lon: entry.lon,
            originalName: entry.originalName || instName
        });
        setDeleteKey(null);
        setMergeConflict(null);
        setStatusMsg(null);
    };

    const cancelEdit = () => { setEditingKey(null); setMergeConflict(null); };

    const handleSave = async (oldName, oldAddress, uniqueId, forceMerge = false) => {
        setSaving(true);
        setMergeConflict(null);
        try {
            let newFixtureName = editForm.name.trim();
            if (editForm.description.trim()) {
                newFixtureName += ` (${editForm.description.trim()})`;
            }

            const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name:    editForm.originalName,
                    old_address: oldAddress,
                    new_name:    newFixtureName,
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
                        ?.entries.find((e, idx) => (e._docId || idx) === uniqueId);
                    const firestoreId = entry?._docId || makeStableId(oldName, oldAddress);
                    await setDoc(
                        doc(db, 'institutes', firestoreId),
                        {
                            name: editForm.name.trim(),
                            description: editForm.description.trim(),
                            originalName: newFixtureName,
                            address: editForm.address.trim(),
                            lat: editForm.lat ?? null,
                            lon: editForm.lon ?? null,
                            updatedAt: serverTimestamp(),
                        }, { merge: true }
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

    const handleAdd = async () => {
        setSaving(true);
        setStatusMsg(null);
        try {
            if (!addForm.name.trim() || !addForm.address.trim()) {
                throw new Error("Nome e indirizzo sono obbligatori");
            }
            if (!db) {
                throw new Error("Connessione al database non disponibile");
            }
            const newFixtureName = addForm.description.trim() ? `${addForm.name.trim()} (${addForm.description.trim()})` : addForm.name.trim();
            const firestoreId = makeStableId(newFixtureName, addForm.address.trim());
            await setDoc(doc(db, 'institutes', firestoreId), {
                name: addForm.name.trim(),
                description: addForm.description.trim(),
                originalName: newFixtureName,
                address: addForm.address.trim(),
                lat: addForm.lat ?? null,
                lon: addForm.lon ?? null,
                type: activeTab,
                updatedAt: serverTimestamp(),
            });
            setStatusMsg({ type: 'ok', text: `Istituto aggiunto con successo.` });
            setIsAdding(false);
            load();
        } catch (err) {
            setStatusMsg({ type: 'err', text: err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (name, address, uniqueId) => {
        setDeleting(true);
        try {
            // Find _docId before API call (state still intact)
            const entry = institutes
                .find(i => i.name === name)
                ?.entries.find((e, idx) => (e._docId || idx) === uniqueId);

            const resp = await fetch(`${API_BASE_URL}/api/fixtures/institutes`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: entry?.originalName || name, address }),
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
            
            setAnimatingDeletes(prev => new Set(prev).add(uniqueId));
            setTimeout(() => {
                setAnimatingDeletes(prev => {
                    const next = new Set(prev);
                    next.delete(uniqueId);
                    return next;
                });
                load();
            }, 350);
        } catch (err) {
            setStatusMsg({ type: 'err', text: err.message });
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="flex flex-col h-full min-h-0">

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

            <div className="flex flex-col gap-3 flex-1 min-h-0">

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

                <div className="flex gap-4 flex-1 min-h-0">

                    {/* ── Left panel ──────────────────────────────────────────── */}
                    <div className="w-[420px] xl:w-[450px] 3xl:w-[500px] 4xl:w-[600px] flex-shrink-0 flex flex-col gap-2">
                        {/* Tabs */}
                        <div className="flex gap-2 border-b border-gray-200 mb-2">
                            <button
                                onClick={() => { setActiveTab('istituto'); setMultiSelectMode(false); setSelectedKeys(new Set()); }}
                                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                                    activeTab === 'istituto' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                                }`}
                            >
                                Istituti
                            </button>
                            <button
                                onClick={() => { setActiveTab('destinazione'); setMultiSelectMode(false); setSelectedKeys(new Set()); }}
                                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                                    activeTab === 'destinazione' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                                }`}
                            >
                                Destinazioni
                            </button>
                        </div>

                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    placeholder="Cerca istituto o indirizzo..."
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    className="w-full px-3 py-2 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                                {search && (
                                    <button
                                        onClick={() => setSearch('')}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-full hover:bg-gray-100 transition-colors"
                                        title="Svuota ricerca"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                            <button
                                onClick={() => {
                                    setIsAdding(true);
                                    setAddForm({ name: '', description: '', address: '', lat: null, lon: null });
                                }}
                                className="px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg border border-transparent whitespace-nowrap shadow-sm"
                            >
                                + Aggiungi
                            </button>
                            {/* Secondary sync button when Firestore has data */}
                            {db && firestoreCount !== null && firestoreCount > 0 && (
                                <div className="relative">
                                    <button
                                        onClick={() => setMenuOpen(!menuOpen)}
                                        className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                                        title="Altre azioni"
                                    >
                                        <MoreVertical className="w-4 h-4" />
                                    </button>
                                    {menuOpen && (
                                        <>
                                            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)}></div>
                                            <div className="absolute right-0 mt-1 w-48 bg-white border border-gray-100 rounded-lg shadow-lg z-50 py-1">
                                                <button
                                                    onClick={() => { setMenuOpen(false); handleSyncFromFixtures(); }}
                                                    disabled={syncing || loading}
                                                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                                >
                                                    {syncing ? 'Sincronizzazione...' : 'Aggiorna da Fixture'}
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {!loading && (
                            <div className="text-xs text-gray-400">
                                {filtered.reduce((n, i) => n + i.entries.length, 0)} voci
                                {search ? ` su ${institutes.reduce((n, i) => n + i.entries.length, 0)} totali` : ''}
                            </div>
                        )}
                        {loading && <div className="text-sm text-gray-400 animate-pulse">Caricamento...</div>}

                        {isAdding && (
                            <div className="rounded-lg border border-green-300 bg-green-50 p-2 flex flex-col gap-1.5 animate-fade-in shadow-sm">
                                <input
                                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-green-400 outline-none"
                                    placeholder="Nome istituto"
                                    value={addForm.name}
                                    onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                                />
                                <input
                                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-green-400 outline-none"
                                    placeholder="Descrizione (opzionale)"
                                    value={addForm.description}
                                    onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                                />
                                <AddressAutocomplete
                                    value={addForm.address}
                                    onChange={v => setAddForm(f => ({ ...f, address: v, lat: null, lon: null }))}
                                    onSelect={({ address, lat, lon }) =>
                                        setAddForm(f => ({ ...f, address, lat, lon }))
                                    }
                                    placeholder="Indirizzo o coordinate (lat, lon)..."
                                />
                                {addForm.lat != null && (
                                    <div className="text-xs text-green-600 font-mono">
                                        {addForm.lat.toFixed(5)}, {addForm.lon.toFixed(5)}
                                    </div>
                                )}
                                <div className="flex gap-1">
                                    <button
                                        onClick={handleAdd}
                                        disabled={saving || !addForm.name.trim() || !addForm.address.trim()}
                                        className="flex-1 flex items-center justify-center gap-1 text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white py-1 rounded-md"
                                    >
                                        <Check className="w-3 h-3" />
                                        {saving ? 'Salvataggio...' : 'Aggiungi'}
                                    </button>
                                    <button
                                        onClick={() => setIsAdding(false)}
                                        className="px-3 flex items-center gap-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 rounded-md"
                                    >
                                        <X className="w-3 h-3" /> Annulla
                                    </button>
                                </div>
                            </div>
                        )}
                        <div 
                            className="overflow-y-auto flex-1 min-h-0 pr-0.5 mt-1"
                            onPointerMove={(e) => {
                                if (!multiSelectMode || !dragState) return;
                                // Handle drag selection across rows by getting element under pointer
                                const elem = document.elementFromPoint(e.clientX, e.clientY);
                                const row = elem?.closest('[data-unique-id]');
                                if (row) {
                                    const idStr = row.getAttribute('data-unique-id');
                                    const uid = isNaN(idStr) ? idStr : Number(idStr);
                                    const hoveredIndex = flattenedIds.indexOf(uid);
                                    if (hoveredIndex !== -1 && hoveredIndex !== dragState.currentIndex) {
                                        const newState = { ...dragState, currentIndex: hoveredIndex };
                                        setDragState(newState);
                                        applyDragRange(hoveredIndex, newState);
                                    }
                                }
                            }}
                        >
                            {filtered.map(inst => (
                                <div key={inst.name} className="mb-0.5">
                                    {inst.entries.map((entry, ei) => {
                                        const uniqueId = entry._docId || ei;
                                        const key     = eKey(inst.name, entry.address, uniqueId);
                                        const isEdit  = editingKey === key;
                                        const isDel   = deleteKey  === key;
                                        const isHL    = highlighted?.name === inst.name && highlighted?.address === entry.address && highlighted?.uniqueId === uniqueId;
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
                                                <input
                                                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-400 outline-none"
                                                    placeholder="Descrizione (opzionale)"
                                                    value={editForm.description}
                                                    onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
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
                                                    <div className="flex flex-col gap-1 bg-amber-50 border border-amber-300 rounded-lg px-2 py-1.5 mt-2">
                                                        <div className="flex items-start gap-1 text-xs text-amber-700">
                                                            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                                            <span>
                                                                Questo indirizzo è già usato da{' '}
                                                                <strong>{mergeConflict.conflict.name}</strong>. Vuoi usare lo stesso nome (unendo le voci) oppure tenerli separati con nomi diversi ma stesso indirizzo?
                                                            </span>
                                                        </div>
                                                        <div className="flex gap-1 mt-1">
                                                            <button
                                                                onClick={() => {
                                                                    // Unisci: change name to match the conflict
                                                                    setEditForm(f => ({ ...f, name: mergeConflict.conflict.name }));
                                                                    // We use setTimeout so state updates before save, or we can just call the API directly with the conflict name.
                                                                    // Let's just update the form and immediately save with the conflict name
                                                                    setTimeout(() => {
                                                                        const oldFormName = editForm.name;
                                                                        editForm.name = mergeConflict.conflict.name;
                                                                        handleSave(inst.name, entry.address, uniqueId, true);
                                                                        editForm.name = oldFormName;
                                                                    }, 0);
                                                                }}
                                                                disabled={saving}
                                                                className="flex-1 text-xs bg-amber-600 hover:bg-amber-700 text-white py-1 px-1 rounded-md disabled:opacity-50"
                                                                title="Usa il nome esistente"
                                                            >
                                                                Unisci
                                                            </button>
                                                            <button
                                                                onClick={() => handleSave(inst.name, entry.address, uniqueId, true)}
                                                                disabled={saving}
                                                                className="flex-1 text-xs bg-blue-600 hover:bg-blue-700 text-white py-1 px-1 rounded-md disabled:opacity-50"
                                                                title="Mantieni il nome attuale"
                                                            >
                                                                Tieni separati
                                                            </button>
                                                            <button
                                                                onClick={() => setMergeConflict(null)}
                                                                className="px-2 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 rounded-md"
                                                            >
                                                                Annulla
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => handleSave(inst.name, entry.address, uniqueId)}
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
                                                    Rimuovere <strong>{entry.originalName || inst.name}</strong> da{' '}
                                                    <strong>{entry.fixture_count}</strong> fixture?
                                                    <span className="block text-gray-500 mt-0.5 font-normal">{entry.address}</span>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => handleDelete(inst.name, entry.address, uniqueId)}
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
                                                data-unique-id={uniqueId}
                                                onPointerDown={(e) => handlePointerDown(e, uniqueId)}
                                                onPointerMove={handlePointerCancelOrMove}
                                                onPointerLeave={handlePointerCancelOrMove}
                                                onPointerCancel={handlePointerCancelOrMove}
                                                onPointerEnter={(e) => handlePointerEnterRow(e, uniqueId)}
                                                onClick={(e) => handleClick(e, inst.name, entry, uniqueId)}
                                                style={{ WebkitUserSelect: 'none', userSelect: 'none', touchAction: multiSelectMode ? 'none' : 'auto' }}
                                                className={`group px-2 py-1.5 rounded-lg border transition-all duration-300 ease-in-out flex items-center gap-2 mb-0.5 ${
                                                    animatingDeletes.has(uniqueId)
                                                        ? 'opacity-0 scale-95 translate-x-8 bg-red-100 border-red-200 shadow-sm'
                                                        : animatingMoves.has(uniqueId)
                                                            ? 'opacity-0 scale-95 -translate-x-8 bg-indigo-100 border-indigo-200 shadow-sm'
                                                            : isHL
                                                                ? 'border-blue-400 bg-blue-50'
                                                                : hasPt
                                                                    ? 'border-gray-100 bg-white hover:border-gray-300'
                                                                    : 'border-amber-100 bg-amber-50/50 hover:border-amber-200'
                                                } ${hasPt && !animatingDeletes.has(uniqueId) && !animatingMoves.has(uniqueId) ? 'cursor-pointer' : 'cursor-default'} ${
                                                    multiSelectMode && selectedKeys.has(uniqueId) && !animatingDeletes.has(uniqueId) && !animatingMoves.has(uniqueId) ? 'ring-2 ring-red-400 bg-red-50' : ''
                                                }`}
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
                                                    {entry.description && (
                                                        <div className="text-[11px] text-gray-500 italic truncate leading-tight mb-0.5">
                                                            {entry.description}
                                                        </div>
                                                    )}
                                                    <div className="text-xs text-gray-500 truncate leading-tight">{entry.address}</div>
                                                </div>
                                                {entry.fixture_count > 1 && (
                                                    <span className="text-xs text-gray-400 flex-shrink-0">×{entry.fixture_count}</span>
                                                )}
                                                {multiSelectMode ? (
                                                    <div className="flex-shrink-0 px-2 pointer-events-none">
                                                        <input 
                                                            type="checkbox" 
                                                            checked={selectedKeys.has(uniqueId)}
                                                            readOnly
                                                            className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
                                                        />
                                                    </div>
                                                ) : (
                                                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                                        <button
                                                            onClick={e => { e.stopPropagation(); handleMoveType(inst.name, entry, uniqueId); }}
                                                            className="p-1 rounded hover:bg-indigo-100 text-gray-400 hover:text-indigo-600"
                                                            title={`Sposta in ${activeTab === 'istituto' ? 'Destinazioni' : 'Istituti'}`}
                                                        >
                                                            <ArrowRightLeft className="w-3 h-3" />
                                                        </button>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); startEdit(inst.name, entry, uniqueId); }}
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
                                                )}
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

                    {/* ── Floating Action Bar for Multi-select ──────────────────── */}
                    {multiSelectMode && (
                        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-white shadow-xl rounded-full px-5 py-3 flex items-center gap-4 z-[9999] border border-red-100 animate-fade-in">
                            <span className="text-sm font-medium text-gray-700">{selectedKeys.size} selezionati</span>
                            <button
                                onClick={handleBulkMove}
                                disabled={deleting || selectedKeys.size === 0}
                                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-full text-sm font-medium shadow flex items-center gap-1"
                            >
                                <ArrowRightLeft className="w-4 h-4" />
                                {deleting ? 'Spostamento...' : 'Sposta'}
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                disabled={deleting || selectedKeys.size === 0}
                                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-full text-sm font-medium shadow flex items-center gap-1"
                            >
                                <Trash2 className="w-4 h-4" />
                                {deleting ? 'Eliminazione...' : 'Elimina'}
                            </button>
                            <button
                                onClick={() => {
                                    setMultiSelectMode(false);
                                    setSelectedKeys(new Set());
                                }}
                                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full text-sm"
                            >
                                Annulla
                            </button>
                        </div>
                    )}

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
                                const isHL = highlighted?.name === pt.name && highlighted?.address === pt.address && highlighted?.uniqueId === pt.uniqueId;
                                return (
                                    <Marker
                                        key={i}
                                        position={[pt.lat, pt.lon]}
                                        icon={makePin(isHL ? '#3b82f6' : '#6b7280', isHL)}
                                        zIndexOffset={isHL ? 1000 : 0}
                                        eventHandlers={{ click: () => handleSelect(pt.name, pt, pt.uniqueId) }}
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
