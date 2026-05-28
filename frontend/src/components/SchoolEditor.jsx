import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Save, X, Trash2, PlusCircle, Database, Search } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';
import { getColorForIndex } from '../utils/colors';
import axios from 'axios';
import API_BASE_URL from '../config';

const SchoolEditor = ({ schools, onSave, instituteColorMap = {}, allDbInstitutes = [] }) => {
    const [editedSchools, setEditedSchools] = useState(schools);
    const [pickerOpenId, setPickerOpenId] = useState(null);
    const [institutes, setInstitutes] = useState([]);
    const [instituteFilter, setInstituteFilter] = useState('');

    const localColorMap = React.useMemo(() => {
        const map = { ...instituteColorMap };
        const usedCount = Object.keys(map).length;
        let nextIndex = usedCount;
        editedSchools.forEach(s => {
            if (s.institute && !map[s.institute]) {
                map[s.institute] = getColorForIndex(nextIndex);
                nextIndex++;
            }
        });
        return map;
    }, [editedSchools, instituteColorMap]);

    useEffect(() => {
        setEditedSchools(schools);
    }, [schools]);

    // Sync with global database
    useEffect(() => {
        const flat = [];
        allDbInstitutes.forEach(inst => {
            if (inst.lat && inst.lon && inst.lat !== 0 && inst.lon !== 0 && inst.address) {
                flat.push({ name: inst.name, address: inst.address, lat: inst.lat, lon: inst.lon });
            }
        });
        setInstitutes(flat);
    }, [allDbInstitutes]);

    const filteredInstitutes = institutes.filter(inst => {
        if (!instituteFilter) return true;
        const q = instituteFilter.toLowerCase();
        return inst.name.toLowerCase().includes(q) || inst.address.toLowerCase().includes(q);
    });

    const handleUpdate = (id, field, value) => {
        setEditedSchools(prev => prev.map(s =>
            s.id === id ? { ...s, [field]: value } : s
        ));
    };

    const handleDelete = (id) => {
        setEditedSchools(prev => prev.filter(s => s.id !== id));
    };

    const handleAdd = () => {
        const newId = editedSchools.length > 0
            ? Math.max(...editedSchools.map(s => s.id)) + 1
            : 1;
        setEditedSchools(prev => [
            ...prev,
            { id: newId, name: 'Nuova Fermata', address: '', demand: 1, lat: 0, lon: 0 }
        ]);
    };

    const handleSave = () => {
        onSave(editedSchools);
    };

    const handlePickerSelect = (schoolId, inst) => {
        handleUpdate(schoolId, 'address', inst.address);
        handleUpdate(schoolId, 'lat', inst.lat);
        handleUpdate(schoolId, 'lon', inst.lon);
        setPickerOpenId(null);
        setInstituteFilter('');
    };

    return (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-full animate-fade-in">
            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                <div>
                    <h3 className="font-semibold text-gray-800 text-lg">Revisione e Modifica Dati</h3>
                    <p className="text-xs text-gray-500">Verifica indirizzi e numero passeggeri prima di ottimizzare.</p>
                </div>
                <div className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full">{editedSchools.length} fermate</div>
            </div>

            <div className="overflow-y-auto flex-1 p-2">
                <table className="w-full text-sm border-separate border-spacing-y-1">
                    <thead className="bg-gray-100 text-gray-600 font-bold uppercase text-xs tracking-wider">
                        <tr>
                            <th className="text-left py-3 px-3 rounded-l-lg">Nome</th>
                            <th className="text-left py-3 px-3">Indirizzo</th>
                            <th className="text-left py-3 px-3">Istituto</th>
                            <th className="text-center py-3 px-3">Pax</th>
                            <th className="text-right py-3 px-3 rounded-r-lg">Azioni</th>
                        </tr>
                    </thead>
                    <tbody>
                        {editedSchools.map((school) => (
                            <tr key={school.id} className="hover:bg-blue-50/50 transition-colors group">
                                <td className="p-2 border-b border-gray-50">
                                    <input
                                        type="text"
                                        className="w-full bg-transparent border-b border-transparent focus:border-blue-500 outline-none px-2 py-1.5 focus:bg-white rounded"
                                        value={school.name}
                                        onChange={(e) => handleUpdate(school.id, 'name', e.target.value)}
                                        placeholder="Nome Fermata"
                                    />
                                </td>
                                <td className="p-2 w-1/2 border-b border-gray-50">
                                    <div className="flex items-center gap-1">
                                        <div className="flex-1">
                                            <AddressAutocomplete
                                                value={school.address}
                                                onChange={(val) => handleUpdate(school.id, 'address', val)}
                                                onSelect={(data) => {
                                                    handleUpdate(school.id, 'address', data.address);
                                                    handleUpdate(school.id, 'lat', data.lat);
                                                    handleUpdate(school.id, 'lon', data.lon);
                                                }}
                                            />
                                        </div>
                                        {institutes.length > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setInstituteFilter('');
                                                    setPickerOpenId(pickerOpenId === school.id ? null : school.id);
                                                }}
                                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex-shrink-0"
                                                title="Seleziona da Lista Istituti"
                                            >
                                                <Database className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </td>
                                <td className="p-2 border-b border-gray-50">
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: school.institute ? (localColorMap[school.institute] || '#e5e7eb') : '#e5e7eb' }}
                                        ></div>
                                        <input
                                            type="text"
                                            className="w-full bg-transparent border-b border-transparent focus:border-blue-500 outline-none px-2 py-1.5 focus:bg-white rounded"
                                            value={school.institute || ''}
                                            onChange={(e) => handleUpdate(school.id, 'institute', e.target.value)}
                                            placeholder="Istituto (Opzionale)"
                                        />
                                    </div>
                                </td>
                                <td className="p-2 text-center w-24 border-b border-gray-50">
                                    <input
                                        type="number"
                                        className="w-full text-center bg-transparent border-b border-transparent focus:border-blue-500 outline-none px-1 py-1.5 focus:bg-white rounded font-mono"
                                        value={school.demand}
                                        onChange={(e) => handleUpdate(school.id, 'demand', parseInt(e.target.value) || 0)}
                                        min="0"
                                    />
                                </td>
                                <td className="p-2 text-right border-b border-gray-50">
                                    <button
                                        onClick={() => handleDelete(school.id)}
                                        className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-20 group-hover:opacity-100"
                                        title="Rimuovi Fermata"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {editedSchools.length === 0 && (
                    <div className="text-center py-10 text-gray-400 italic">Nessuna fermata caricata. Aggiungine una manualmente o carica un file.</div>
                )}

                <div className="mt-4 flex justify-center">
                    <button
                        onClick={handleAdd}
                        className="flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium px-4 py-2 hover:bg-blue-50 rounded-lg transition-colors border border-dashed border-blue-200 w-full justify-center"
                    >
                        <PlusCircle className="w-4 h-4" /> Aggiungi Fermata Manuale
                    </button>
                </div>
            </div>

            <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-between items-center">
                <div className="text-xs text-gray-500 italic">
                    * Controlla attentamente gli indirizzi per una pianificazione più accurata.
                </div>
                <button
                    onClick={handleSave}
                    className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg shadow-green-200 transition-all flex items-center gap-2 transform hover:-translate-y-0.5"
                >
                    <Save className="w-5 h-5" /> CONFERMA DATI
                </button>
            </div>

            {/* Institute picker modal */}
            {pickerOpenId !== null && createPortal(
                <div
                    className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
                    onMouseDown={(e) => { if (e.target === e.currentTarget) { setPickerOpenId(null); setInstituteFilter(''); } }}
                >
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[70vh]">
                        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h4 className="font-semibold text-gray-800">Lista Istituti</h4>
                                <p className="text-xs text-gray-400">{filteredInstitutes.length} indirizzi verificati</p>
                            </div>
                            <button
                                onClick={() => { setPickerOpenId(null); setInstituteFilter(''); }}
                                className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="p-3 border-b border-gray-100">
                            <div className="relative">
                                <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
                                <input
                                    autoFocus
                                    type="text"
                                    placeholder="Cerca per nome o indirizzo..."
                                    className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                    value={instituteFilter}
                                    onChange={(e) => setInstituteFilter(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="overflow-y-auto flex-1">
                            {filteredInstitutes.length === 0 ? (
                                <div className="text-center py-8 text-gray-400 text-sm italic">Nessun risultato</div>
                            ) : (
                                filteredInstitutes.map((inst, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-50 transition-colors"
                                        onClick={() => handlePickerSelect(pickerOpenId, inst)}
                                    >
                                        <div className="font-medium text-gray-800 text-sm">{inst.name}</div>
                                        <div className="text-xs text-gray-500 mt-0.5">{inst.address}</div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default SchoolEditor;
