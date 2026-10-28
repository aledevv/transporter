import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MapPin, Loader2, Navigation, Building2, MapPinned, Database } from 'lucide-react';
import axios from 'axios';
import debounce from 'lodash/debounce';
import API_BASE_URL from '../config';
import { matchLocalPlaces } from '../utils/placeMatch';

const newSessionToken = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function SuggestionIcon({ type }) {
    if (type === 'database') return <Database className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />;
    if (type === 'route' || type === 'street_address') return <Navigation className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />;
    if (type === 'establishment' || type === 'point_of_interest') return <Building2 className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />;
    return <MapPinned className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />;
}

const AddressAutocomplete = ({ value, onChange, onSelect, placeholder = 'Cerca indirizzo...', localPlaces = [] }) => {
    const [suggestions, setSuggestions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const [searchFailed, setSearchFailed] = useState(false);

    const lastSearchedRef = useRef(null); // last value we actually searched for
    // One Google session from the first keystroke to the place picked (billed as one)
    const sessionRef = useRef(newSessionToken());
    const localPlacesRef = useRef(localPlaces);
    localPlacesRef.current = localPlaces;
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
            // Pasted coordinates are offered even when the address search is down
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

            const local = matchLocalPlaces(query, localPlacesRef.current);
            if (local.length) {
                setSuggestions(customSuggestion ? [customSuggestion, ...local] : local);
                setIsOpen(true);
            }

            let raw = [];
            if (query.length >= 3) {
                setLoading(true);
                try {
                    const response = await axios.get(`${API_BASE_URL}/api/places/autocomplete`, {
                        params: { q: query, session: sessionRef.current },
                    });
                    raw = response.data?.predictions ?? [];
                    setSearchFailed(response.data?.status === 'UNAVAILABLE');
                } catch (error) {
                    console.error('Autocomplete error:', error);
                    setSearchFailed(true);
                } finally {
                    setLoading(false);
                }
            }

            const finalSuggestions = [...(customSuggestion ? [customSuggestion] : []), ...local, ...raw];
            setSuggestions(finalSuggestions);
            setIsOpen(finalSuggestions.length > 0);
        }, 300),
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

    const handleSelect = async (suggestion) => {
        const mainText = suggestion.structured_formatting?.main_text ?? suggestion.description ?? '';
        const secondaryText = suggestion.structured_formatting?.secondary_text ?? '';
        let displayValue = secondaryText ? `${mainText}, ${secondaryText}` : mainText;

        if (suggestion.place_id && String(suggestion.place_id).startsWith('coord_')) {
            displayValue = `${suggestion.lat}, ${suggestion.lon}`;
        }

        setIsOpen(false);
        lastSearchedRef.current = displayValue;
        onChange(displayValue);

        if (onSelect && suggestion.lat != null && suggestion.lon != null) {
            onSelect({ address: displayValue, lat: suggestion.lat, lon: suggestion.lon });
        } else if (onSelect && suggestion.source === 'google') {
            // Google suggestions carry no coordinates: ask for them, closing the session
            setLoading(true);
            try {
                const { data } = await axios.get(`${API_BASE_URL}/api/places/details`, {
                    params: { place_id: suggestion.place_id, session: sessionRef.current },
                });
                if (data.lat != null) onSelect({ address: displayValue, lat: data.lat, lon: data.lon });
            } catch (error) {
                console.error('Place details error:', error);
                setSearchFailed(true);
            } finally {
                setLoading(false);
            }
        }
        sessionRef.current = newSessionToken();
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
                <ul ref={dropdownRef} style={dropdownStyle} className="bg-white border border-gray-200 rounded-xl shadow-xl max-h-80 overflow-y-auto">
                    {suggestions.map((item, i) => {
                        const main = item.structured_formatting?.main_text ?? item.description ?? '';
                        const secondary = item.structured_formatting?.secondary_text ?? '';
                        const type = item.types?.[0] ?? '';
                        const firstOfSource = item.source && suggestions.findIndex(s => s.source === item.source) === i;
                        return (
                            <React.Fragment key={item.place_id}>
                            {firstOfSource && item.source === 'database' && (
                                <li className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-600">Dal database</li>
                            )}
                            <li
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
                            </React.Fragment>
                        );
                    })}
                    {suggestions.some(s => s.source === 'google') && (
                        <li className="flex justify-end px-3 py-1.5">
                            <img src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3_hdpi.png" alt="Powered by Google" className="h-[18px]" />
                        </li>
                    )}
                </ul>,
                document.body
            )}
            {searchFailed && (
                <div className="mt-1 text-xs text-amber-700">
                    Ricerca indirizzi non disponibile al momento: riprova tra poco o incolla le coordinate (lat, lon).
                </div>
            )}
        </div>
    );
};

export default AddressAutocomplete;
