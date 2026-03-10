import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// Firebase is initialised lazily after the frontend fetches /api/config.
// Call initFirebase(config) once; subsequent calls are ignored.
let db = null;

export function initFirebase(config) {
    if (db) return db;
    const app = initializeApp(config);
    db = getFirestore(app);
    return db;
}

export function getDb() {
    return db;
}
