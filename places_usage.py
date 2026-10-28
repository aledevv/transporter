"""
Monthly counter of Google Places calls, kept in Firestore (usage/places-YYYY-MM)
so it survives Cloud Run restarts and is shared by all instances.

Before each Google call the backend asks allow(kind): above the monthly cap
(well under Google's free tier) or when the counter can't be read, the answer
is False and the caller uses Nominatim instead. Costs fail closed.
"""
import os
import time
import threading
from datetime import datetime, timezone

import requests

# Monthly caps, well under Google's 10,000 free events per SKU
LIMITS = {
    'autocomplete': int(os.environ.get('PLACES_MONTHLY_AUTOCOMPLETE', 5000)),
    'details': int(os.environ.get('PLACES_MONTHLY_DETAILS', 2000)),
}

_lock = threading.Lock()
_token = {'value': None, 'expires': 0}


def _project():
    return os.environ.get('FIREBASE_PROJECT_ID') or os.environ.get('GOOGLE_CLOUD_PROJECT')


def _base_and_headers():
    emulator = os.environ.get('FIRESTORE_EMULATOR_HOST')
    if emulator:
        return f"http://{emulator}/v1", {'Authorization': 'Bearer owner'}
    if not _token['value'] or _token['expires'] < time.time() + 60:
        import google.auth
        import google.auth.transport.requests
        creds, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/datastore'])
        creds.refresh(google.auth.transport.requests.Request())
        _token['value'] = creds.token
        _token['expires'] = creds.expiry.replace(tzinfo=timezone.utc).timestamp() if creds.expiry else time.time() + 600
    return 'https://firestore.googleapis.com/v1', {'Authorization': f"Bearer {_token['value']}"}


def _doc_path():
    month = datetime.now(timezone.utc).strftime('%Y-%m')
    return f"projects/{_project()}/databases/(default)/documents/usage/places-{month}"


def allow(kind):
    """True if one more `kind` call ('autocomplete' | 'details') fits this month's cap; counts it."""
    if kind not in LIMITS or not _project():
        return False
    try:
        with _lock:
            base, headers = _base_and_headers()
            path = _doc_path()
            resp = requests.get(f"{base}/{path}", headers=headers, timeout=4)
            used = 0
            if resp.status_code == 200:
                used = int(resp.json().get('fields', {}).get(kind, {}).get('integerValue', 0))
            elif resp.status_code != 404:
                return False
            if used >= LIMITS[kind]:
                return False
            write = {'writes': [{'transform': {'document': path, 'fieldTransforms': [
                {'fieldPath': kind, 'increment': {'integerValue': '1'}},
            ]}}]}
            db = path.split('/documents/')[0]
            ok = requests.post(f"{base}/{db}/documents:commit", json=write, headers=headers, timeout=4)
            return ok.status_code == 200
    except Exception as e:
        print(f"[Places usage] counter unavailable, not calling Google: {e}")
        return False
