import React, { useCallback, useState } from 'react';
import axios from 'axios';
import { Upload, FileType, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

const FileUpload = ({ onUploadSuccess }) => {
    const [dragActive, setDragActive] = useState(false);
    const [loading, setLoading] = useState(false);
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
        setLoading(true);

        // Validations
        if (!file.name.endsWith('.xlsx')) {
            setError("Sono ammessi solo file .xlsx");
            setLoading(false);
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await axios.post('http://localhost:5001/api/upload', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            onUploadSuccess(response.data.schools);
        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || "Caricamento fallito. Il server backend è attivo?");
        } finally {
            setLoading(false);
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

                {loading ? (
                    <div className="flex flex-col items-center gap-2 text-blue-600">
                        <Loader2 className="w-10 h-10 animate-spin" />
                        <p className="font-medium">Caricamento ed elaborazione...</p>
                    </div>
                ) : (
                    <>
                        <div className="p-4 bg-white rounded-full shadow-sm">
                            <Upload className="w-8 h-8 text-blue-500" />
                        </div>
                        <div className="text-center">
                            <p className="text-lg font-medium text-gray-700">Clicca per caricare o trascina il file</p>
                            <p className="text-sm text-gray-500">File Excel (.xlsx)</p>
                        </div>
                    </>
                )}
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
