
import React, { useState, useEffect, useRef } from 'react';
import { MapPin, Search, Loader2 } from 'lucide-react';
import axios from 'axios';
import debounce from 'lodash/debounce';

const AddressAutocomplete = ({ value, onChange, onSelect }) => {
    const [suggestions, setSuggestions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);

    const lastSelectedValueRef = useRef(null);

    // Create a debounced search function
    const searchAddress = React.useCallback(
        debounce(async (query) => {
            if (!query || query.length < 3) {
                setSuggestions([]);
                return;
            }

            setLoading(true);
            try {
                // Use OpenStreetMap Nominatim API
                const response = await axios.get(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`
                );
                setSuggestions(response.data);
                setIsOpen(true);
            } catch (error) {
                console.error("Autocomplete error:", error);
            } finally {
                setLoading(false);
            }
        }, 500),
        []
    );

    useEffect(() => {
        // If the current value matches what we just selected, don't search/reopen
        if (value === lastSelectedValueRef.current) {
            return;
        }
        searchAddress(value);
    }, [value, searchAddress]);

    // Close dropdown when clicking outside
    const wrapperRef = useRef(null);
    useEffect(() => {
        function handleClickOutside(event) {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [wrapperRef]);

    const handleSelect = (suggestion) => {
        setIsOpen(false);
        // Display name is often too long, maybe take first part?
        // Let's use display_name for now.
        lastSelectedValueRef.current = suggestion.display_name;
        onChange(suggestion.display_name);

        // Pass parent the full object (lat/lon)
        if (onSelect) {
            onSelect({
                address: suggestion.display_name,
                lat: suggestion.lat,
                lon: suggestion.lon
            });
        }
    };

    return (
        <div className="relative" ref={wrapperRef}>
            <MapPin className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
            <input
                type="text"
                className="w-full pl-9 pr-10 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                placeholder="Cerca destinazione..."
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
                <ul className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    {suggestions.map((item) => (
                        <li
                            key={item.place_id}
                            className="px-4 py-3 hover:bg-gray-50 cursor-pointer text-sm text-gray-700 border-b border-gray-50 last:border-0"
                            onClick={() => handleSelect(item)}
                        >
                            <div className="font-medium text-gray-900">{item.display_name.split(',')[0]}</div>
                            <div className="text-xs text-gray-500 truncate">{item.display_name}</div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default AddressAutocomplete;
