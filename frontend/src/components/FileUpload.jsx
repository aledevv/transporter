import React, { useCallback, useState } from 'react';
import axios from 'axios';
import { Upload, AlertCircle } from 'lucide-react';
import API_BASE_URL from '../config';

// Reads the first sheet of the Excel as it is; every check happens in the review window
const FileUpload = ({ onSheetRead, onLoadStart, onLoadEnd }) => {
    const [dragActive, setDragActive] = useState(false);
    const [error, setError] = useState(null);

    const handleFiles = async (file) => {
        setError(null);
        if (!file.name.toLowerCase().endsWith('.xlsx')) {
            setError("Sono ammessi solo file .xlsx");
            return;
        }
        if (onLoadStart) onLoadStart();
        const formData = new FormData();
        formData.append('file', file);
        try {
            const response = await axios.post(`${API_BASE_URL}/api/sheet/read`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            if (onSheetRead) await onSheetRead(response.data);
        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || "Caricamento fallito.");
        } finally {
            if (onLoadEnd) onLoadEnd();
        }
    };

    const handleDrag = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    }, []);

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFiles(e.dataTransfer.files[0]);
        }
    };

    const handleChange = (e) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            handleFiles(e.target.files[0]);
            e.target.value = '';
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
