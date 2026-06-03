import React, { useCallback, useState } from 'react';
import axios from 'axios';
import { Upload, FileType, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import API_BASE_URL from '../config';

const FileUpload = ({ onUploadSuccess, onRawSchoolsReady, onValidationNeeded, onLoadStart, onLoadProgress, onLoadEnd }) => {
    const [dragActive, setDragActive] = useState(false);
    // const [loading, setLoading] = useState(false); // Using parent state
    const [error, setError] = useState(null);

    const handleDrag = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFiles(e.dataTransfer.files[0]);
        }
    }, []);

    const handleChange = (e) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            handleFiles(e.target.files[0]);
        }
    };

    const handleFiles = async (file) => {
        setError(null);
        if (onLoadStart) onLoadStart();

        // Validations
        if (!file.name.endsWith('.xlsx')) {
            setError("Sono ammessi solo file .xlsx");
            if (onLoadEnd) onLoadEnd();
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            // 1. Start Upload
            const response = await axios.post(`${API_BASE_URL}/api/upload`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });

            const taskId = response.data.task_id;

            // 2. Poll Status
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await axios.get(`${API_BASE_URL}/api/status/${taskId}`);
                    const { status, progress, message, result, error: taskError } = statusRes.data;

                    if (onLoadProgress) onLoadProgress({ progress, message, totalAddresses: statusRes.data.total_addresses, aiExtraSeconds: statusRes.data.ai_extra_seconds || 0, isAiPhase: statusRes.data.is_ai_phase || false });

                    if (status === 'completed') {
                        clearInterval(pollInterval);
                        if (onUploadSuccess) onUploadSuccess({
                            schools: result,
                            correctedFile: statusRes.data.corrected_file,
                            addressCorrections: statusRes.data.address_corrections ?? [],
                            correctionStatus: statusRes.data.correction_status,
                            unresolvedByAI: statusRes.data.unresolved_by_ai ?? [],
                        });
                        if (onLoadEnd) onLoadEnd();
                    } else if (status === 'validation_needed') {
                        clearInterval(pollInterval);
                        if (onValidationNeeded) onValidationNeeded({
                            schools: statusRes.data.raw_schools,
                            errors: statusRes.data.errors,
                            taskId: taskId
                        });
                        if (onLoadEnd) onLoadEnd();
                    } else if (status === 'awaiting_db_match') {
                        clearInterval(pollInterval);
                        if (onRawSchoolsReady) onRawSchoolsReady({ rawSchools: statusRes.data.raw_schools, taskId });
                        if (onLoadEnd) onLoadEnd();
                    } else if (status === 'error') {
                        clearInterval(pollInterval);
                        setError(taskError || "Errore durante l'elaborazione");
                        if (onLoadEnd) onLoadEnd();
                    }
                } catch (e) {
                    console.error("Polling error", e);
                    // Don't clear interval immediately on network blip, but maybe handle max retries
                }
            }, 1000);

        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || "Caricamento fallito.");
            if (onLoadEnd) onLoadEnd();
        }
    };

    return (
        <div className="w-full">
            <div
                className={`relative border-2 border-dashed rounded-xl p-8 transition-all duration-200 ease-in-out flex flex-col items-center justify-center gap-3
            ${dragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50'}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
            >
                <input
                    type="file"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={handleChange}
                    accept=".xlsx"
                />

                <div className="p-4 bg-white rounded-full shadow-sm">
                    <Upload className="w-8 h-8 text-blue-500" />
                </div>
                <div className="text-center">
                    <p className="text-lg font-medium text-gray-700">Clicca per caricare o trascina il file</p>
                    <p className="text-sm text-gray-500">File Excel (.xlsx)</p>
                </div>
            </div>

            {error && (
                <div className="mt-3 flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-md border border-red-100">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span className="text-sm">{error}</span>
                </div>
            )}
        </div>
    );
};

export default FileUpload;
