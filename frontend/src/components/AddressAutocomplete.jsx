import React, { useState, useEffect, useRef } from 'react';
import { MapPin, Loader2, Navigation, Building2, MapPinned } from 'lucide-react';
import axios from 'axios';
import debounce from 'lodash/debounce';
import API_BASE_URL from '../config';

function SuggestionIcon({ type }) {
    if (type === 'route' || type === 'street_address') return <Navigation className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />;
    if (type === 'establishment' || type === 'point_of_interest') return <Building2 className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />;
    return <MapPinned className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />;
}

const AddressAutocomplete = ({ value, onChange, onSelect, placeholder = 'Cerca indirizzo...' }) => {
    const [suggestions, setSuggestions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);

    const lastSelectedValueRef = useRef(null);

    const searchAddress = React.useCallback(
        debounce(async (query) => {
            if (!query || query.length < 2) {
                setSuggestions([]);
                return;
            }
            setLoading(true);
            try {
                const response = await axios.get(`${API_BASE_URL}/api/places/autocomplete`, {
                    params: { q: query },
                });
                const raw = response.data?.predictions ?? [];
                setSuggestions(raw);
                setIsOpen(raw.length > 0);
            } catch (error) {
                console.error('Autocomplete error:', error);
            } finally {
                setLoading(false);
            }
        }, 250),
        []
    );

    useEffect(() => {
        if (value === lastSelectedValueRef.current) return;
        searchAddress(value);
    }, [value, searchAddress]);

    const wrapperRef = useRef(null);
    useEffect(() => {
        function handleClickOutside(event) {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = (suggestion) => {
        const mainText = suggestion.structured_formatting?.main_text ?? suggestion.description ?? '';
        const secondaryText = suggestion.structured_formatting?.secondary_text ?? '';
        const displayValue = secondaryText ? `${mainText}, ${secondaryText}` : mainText;

        setIsOpen(false);
        lastSelectedValueRef.current = displayValue;
        onChange(displayValue);

        if (onSelect && suggestion.lat != null && suggestion.lon != null) {
            onSelect({ address: displayValue, lat: suggestion.lat, lon: suggestion.lon });
        }
    };

    return (
        <div className="relative" ref={wrapperRef}>
            <MapPin className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
            <input
                type="text"
                className="w-full pl-9 pr-10 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                placeholder={placeholder}
                value={value}
                onChange={(e) => {
                    onChange(e.target.value);
                    setIsOpen(true);
                }}
            />
            {loading && (
                <div className="absolute right-3 top-3">
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                </div>
            )}

            {isOpen && suggestions.length > 0 && (
                <ul className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl max-h-72 overflow-y-auto">
                    {suggestions.map((item) => {
                        const main = item.structured_formatting?.main_text ?? item.description ?? '';
                        const secondary = item.structured_formatting?.secondary_text ?? '';
                        const type = item.types?.[0] ?? '';
                        return (
                            <li
                                key={item.place_id}
                                className="flex items-start gap-3 px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0 transition-colors"
                                onMouseDown={(e) => { e.preventDefault(); handleSelect(item); }}
                            >
                                <SuggestionIcon type={type} />
                                <div className="min-w-0">
                                    <div className="font-medium text-gray-900 text-sm">{main}</div>
                                    {secondary && (
                                        <div className="text-xs text-gray-500 truncate">{secondary}</div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default AddressAutocomplete;
