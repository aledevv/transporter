import React, { useState } from 'react';
import axios from 'axios';
import { AlertCircle, AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import API_BASE_URL from '../config';

const ValidationPreview = ({ data, onConfirm, onCancel }) => {
    const { schools, errors, taskId } = data;
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState(null);
    const [showValid, setShowValid] = useState(false);

    const handleConfirm = async () => {
        setIsSubmitting(true);
        setSubmitError(null);
        try {
            await axios.post(`${API_BASE_URL}/api/confirm-validation`, { task_id: taskId });
            onConfirm({ rawSchools: schools, taskId });
        } catch (error) {
            console.error('Error confirming validation:', error);
            setSubmitError(error.response?.data?.error || "Errore durante la conferma. Riprova.");
            setIsSubmitting(false);
        }
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-4 space-y-6">
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded-r-md">
                <div className="flex">
                    <div className="flex-shrink-0">
                        <AlertTriangle className="h-5 w-5 text-yellow-400" />
                    </div>
                    <div className="ml-3">
                        <h3 className="text-sm font-medium text-yellow-800">
                            Attenzione: Il file contiene righe con errori
                        </h3>
                        <div className="mt-2 text-sm text-yellow-700">
                            <p>
                                Abbiamo trovato <strong>{schools.length}</strong> fermate valide, ma <strong>{errors.length}</strong> righe presentano problemi e non verranno importate se prosegui.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-red-50 border-b border-red-100">
                    <h3 className="text-sm font-medium text-red-800 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        Righe scartate ({errors.length})
                    </h3>
                </div>
                <div className="max-h-60 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Riga (Excel)</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Problema riscontrato</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {errors.map((err, i) => (
                                <tr key={i}>
                                    <td className="px-4 py-2 text-sm text-gray-900 font-medium">Riga {err.row}</td>
                                    <td className="px-4 py-2 text-sm text-red-600">{err.reason}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <button 
                    onClick={() => setShowValid(!showValid)}
                    className="w-full px-4 py-3 bg-green-50 border-b border-green-100 flex justify-between items-center hover:bg-green-100 transition-colors"
                >
                    <h3 className="text-sm font-medium text-green-800 flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" />
                        Anteprima righe valide ({schools.length})
                    </h3>
                    {showValid ? <ChevronUp className="w-5 h-5 text-green-700" /> : <ChevronDown className="w-5 h-5 text-green-700" />}
                </button>
                {showValid && (
                    <div className="max-h-80 overflow-y-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Nome</th>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Indirizzo</th>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Pax</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {schools.slice(0, 50).map((school, i) => (
                                    <tr key={i}>
                                        <td className="px-4 py-2 text-sm text-gray-900">{school.name}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">{school.address}</td>
                                        <td className="px-4 py-2 text-sm text-gray-900 font-medium">{school.demand}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {schools.length > 50 && (
                            <div className="p-3 text-center text-sm text-gray-500 bg-gray-50 border-t border-gray-200">
                                Mostrando le prime 50 di {schools.length} righe valide.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {submitError && (
                <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-100">
                    {submitError}
                </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-4 border-t">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={isSubmitting}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                    Annulla e ricarica
                </button>
                <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={isSubmitting}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                    {isSubmitting ? (
                        <>
                            <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                            Elaborazione in corso...
                        </>
                    ) : (
                        "Procedi scartando gli errori"
                    )}
                </button>
            </div>
        </div>
    );
};

export default ValidationPreview;
