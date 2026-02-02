import React, { useState, useEffect } from 'react';
import { Pencil, Save, X, Trash2, PlusCircle } from 'lucide-react';
import AddressAutocomplete from './AddressAutocomplete';

const SchoolEditor = ({ schools, onSave }) => {
    const [editedSchools, setEditedSchools] = useState(schools);

    // Sync if props change
    useEffect(() => {
        setEditedSchools(schools);
    }, [schools]);

    const handleUpdate = (id, field, value) => {
        setEditedSchools(prev => prev.map(s =>
            s.id === id ? { ...s, [field]: value } : s
        ));
    };

    const handleDelete = (id) => {
        setEditedSchools(prev => prev.filter(s => s.id !== id));
    };

    const handleAdd = () => {
        // Generate a new ID (max + 1 or timestamp)
        // This is a simple client-side ID generation
        const newId = editedSchools.length > 0
            ? Math.max(...editedSchools.map(s => s.id)) + 1
            : 1;

        setEditedSchools(prev => [
            ...prev,
            {
                id: newId,
                name: 'Nuova Fermata',
                address: '',
                demand: 1,
                lat: 0,
                lon: 0
            }
        ]);
    };

    const handleSave = () => {
        onSave(editedSchools);
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
                                    <div className="relative">
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
                    * Controlla attentamente gli indirizzi per un routing accurato.
                </div>
                <button
                    onClick={handleSave}
                    className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg shadow-green-200 transition-all flex items-center gap-2 transform hover:-translate-y-0.5"
                >
                    <Save className="w-5 h-5" /> CONFERMA DATI
                </button>
            </div>
        </div>
    );
};

export default SchoolEditor;
