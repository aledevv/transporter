from __future__ import annotations

import json
import os
import threading

_CACHE_FILE = os.path.join(os.path.dirname(__file__), '.nominatim_cache.json')
_lock = threading.Lock()
_cache: dict = {}


def _load():
    global _cache
    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE) as f:
                _cache = json.load(f)
        except (json.JSONDecodeError, OSError):
            _cache = {}


def get(query: str, limit: int) -> list | None:
    return _cache.get(f"{query.lower().strip()}|{limit}")


def store(query: str, limit: int, results: list):
    key = f"{query.lower().strip()}|{limit}"
    with _lock:
        _cache[key] = results
        try:
            with open(_CACHE_FILE, 'w') as f:
                json.dump(_cache, f, ensure_ascii=False)
        except OSError:
            pass  # best-effort persistence


def clear():
    """Clear in-memory cache (does not affect the persisted file)."""
    global _cache
    with _lock:
        _cache = {}


_load()
