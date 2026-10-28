import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

// Firebase is initialised lazily after the frontend fetches /api/config.
// Call initFirebase(config) once; subsequent calls are ignored.
let db = null;

export function initFirebase(config) {
    if (db) return db;
    const app = initializeApp(config);
    db = getFirestore(app);
    // Local testing against the Firestore emulator (e.g. VITE_FIRESTORE_EMULATOR=127.0.0.1:8080):
    // nothing is read from or written to the real database
    const emulator = import.meta.env.DEV && import.meta.env.VITE_FIRESTORE_EMULATOR;
    if (emulator) {
        const [host, port] = emulator.split(':');
        connectFirestoreEmulator(db, host, Number(port));
        console.info(`Firestore emulator: ${emulator}`);
    }
    return db;
}

export function getDb() {
    return db;
}
