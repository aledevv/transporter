"""Thread-safe global rate limiter for the Nominatim API (1 req/s policy)."""
import time
import threading

_lock = threading.Lock()
_last_call_time: float = 0.0
_MIN_GAP = 1.2  # seconds — 20% buffer over Nominatim's 1/s limit


def wait():
    """Block until it is safe to make the next Nominatim request."""
    global _last_call_time
    with _lock:
        now = time.monotonic()
        gap = now - _last_call_time
        if gap < _MIN_GAP:
            time.sleep(_MIN_GAP - gap)
        _last_call_time = time.monotonic()
