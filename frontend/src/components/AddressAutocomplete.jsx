import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
    const [isFocused, setIsFocused] = useState(false);

    const lastSearchedRef = useRef(null); // last value we actually searched for
    const inputRef = useRef(null);
    const dropdownRef = useRef(null);
    const [dropdownStyle, setDropdownStyle] = useState({});

    const searchAddress = React.useCallback(
        debounce(async (query) => {
            if (!query || query.length < 2) {
                setSuggestions([]);
                setIsOpen(false);
                return;
            }
            setLoading(true);
            try {
                const response = await axios.get(`${API_BASE_URL}/api/places/autocomplete`, {
                    params: { q: query },
                });
                const raw = response.data?.predictions ?? [];
                
                const coordMatch = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]+\s*(-?\d+(?:\.\d+)?)\s*$/);
                let customSuggestion = null;
                if (coordMatch) {
                    const lat = parseFloat(coordMatch[1]);
                    const lon = parseFloat(coordMatch[2]);
                    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                        customSuggestion = {
                            place_id: `coord_${lat}_${lon}`,
                            description: `${lat}, ${lon}`,
                            structured_formatting: {
                                main_text: 'Usa coordinate esatte',
                                secondary_text: `${lat}, ${lon}`
                            },
                            types: ['geocode'],
                            lat: lat,
                            lon: lon
                        };
                    }
                }
                
                const finalSuggestions = customSuggestion ? [customSuggestion, ...raw] : raw;
                setSuggestions(finalSuggestions);
                setIsOpen(finalSuggestions.length > 0);
            } catch (error) {
                console.error('Autocomplete error:', error);
            } finally {
                setLoading(false);
            }
        }, 250),
        []
    );

    // Only search when focused and value actually changed due to typing
    useEffect(() => {
        if (!isFocused) return;
        if (value === lastSearchedRef.current) return;
        lastSearchedRef.current = value;
        searchAddress(value);
    }, [value, searchAddress, isFocused]);

    // Recompute portal position when open
    useEffect(() => {
        if (isOpen && inputRef.current) {
            const rect = inputRef.current.getBoundingClientRect();
            setDropdownStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                left: rect.left,
                width: rect.width,
                zIndex: 9999,
            });
        }
    }, [isOpen, suggestions]);

    const wrapperRef = useRef(null);
    useEffect(() => {
        function handleClickOutside(event) {
            if (
                wrapperRef.current && !wrapperRef.current.contains(event.target) &&
                (!dropdownRef.current || !dropdownRef.current.contains(event.target))
            ) {
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
        lastSearchedRef.current = displayValue;
        onChange(displayValue);

        if (onSelect && suggestion.lat != null && suggestion.lon != null) {
            onSelect({ address: displayValue, lat: suggestion.lat, lon: suggestion.lon });
        }
    };

    return (
        <div className="relative" ref={wrapperRef}>
            <MapPin className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
            <input
                ref={inputRef}
                type="text"
                className="w-full pl-9 pr-10 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                placeholder={placeholder}
                value={value}
                onChange={(e) => {
                    onChange(e.target.value);
                    setIsOpen(true);
                }}
                onFocus={() => {
                    setIsFocused(true);
                    lastSearchedRef.current = value; // don't search existing value on focus
                }}
                onBlur={() => {
                    setIsFocused(false);
                    // Small delay so onMouseDown on suggestion can fire first
                    setTimeout(() => setIsOpen(false), 150);
                }}
            />
            {loading && (
                <div className="absolute right-3 top-3">
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                </div>
            )}

            {isOpen && suggestions.length > 0 && createPortal(
                <ul ref={dropdownRef} style={dropdownStyle} className="bg-white border border-gray-200 rounded-xl shadow-xl max-h-72 overflow-y-auto">
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
                </ul>,
                document.body
            )}
        </div>
    );
};

export default AddressAutocomplete;
