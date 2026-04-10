"""
school_cache.py
===============
Loads school_address_cache.json and provides fuzzy-match suggestions
when an address fails to geocode.

Used by app.py during the geocoding phase to enrich 'geocoding_failed'
entries with a cache suggestion for the frontend to display.
"""
import json
import os
from pathlib import Path
from difflib import SequenceMatcher
from typing import Optional

_CACHE_PATH = Path(__file__).parent / "school_address_cache.json"
_cache: Optional[dict] = None  # {school_name: normalized_address}


def _load() -> dict:
    global _cache
    if _cache is None:
        if _CACHE_PATH.exists():
            with open(_CACHE_PATH, encoding="utf-8") as f:
                _cache = json.load(f)
        else:
            _cache = {}
    return _cache


def get_exact(school_name: str) -> Optional[str]:
    """
    Returns the cached normalized address for an exact (case-insensitive) name match,
    or None if the name is not in the cache.
    Used by AddressCorrector to bypass the AI for already-known schools.
    """
    cache = _load()
    # Try exact first, then case-insensitive
    if school_name in cache:
        return cache[school_name]
    name_lower = school_name.strip().lower()
    for k, v in cache.items():
        if k.lower() == name_lower:
            return v
    return None


def _similarity(a: str, b: str) -> float:
    """SequenceMatcher ratio on lowercased strings."""
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def find_suggestion(
    school_name: str,
    raw_address: str,
    name_threshold: float = 0.70,
    addr_threshold: float = 0.60,
) -> Optional[dict]:
    """
    Returns a dict {'name': ..., 'address': ...} if a good cache match is found,
    otherwise None.

    Matching strategy (OR logic — any match is enough):
      1. High name similarity  (≥ name_threshold)
      2. High address similarity (≥ addr_threshold)

    The returned candidate is the one with the highest combined score.
    """
    cache = _load()
    if not cache:
        return None

    best: Optional[dict] = None
    best_score = 0.0

    for cached_name, cached_addr in cache.items():
        name_score = _similarity(school_name, cached_name) if school_name else 0.0
        addr_score = _similarity(raw_address, cached_addr) if raw_address else 0.0

        # Must pass at least one threshold
        if name_score < name_threshold and addr_score < addr_threshold:
            continue

        # Skip if the cached address is exactly the same as the bad one (wouldn't help)
        if cached_addr.strip().lower() == raw_address.strip().lower():
            continue

        combined = max(name_score, addr_score)  # best single signal wins
        if combined > best_score:
            best_score = combined
            best = {"name": cached_name, "address": cached_addr, "score": round(combined, 3)}

    return best


def reload():
    """Force reload of cache from disk (useful after build_school_cache.py runs)."""
    global _cache
    _cache = None
    _load()
