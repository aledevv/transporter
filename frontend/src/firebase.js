import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

// Firebase is initialised lazily after the frontend fetches /api/config.
// Call initFirebase(config) once; subsequent calls are ignored.
let db = null;

export function initFirebase(config, appCheckSiteKey) {
    if (db) return db;
    const app = initializeApp(config);
    const emulator = import.meta.env.DEV && import.meta.env.VITE_FIRESTORE_EMULATOR;
    // App Check: proves requests come from this site (reCAPTCHA Enterprise, invisible).
    // Off until the backend hands out a site key; never with the emulator.
    if (appCheckSiteKey && !emulator) {
        // On localhost a debug token is used instead (printed in the console the first time,
        // to register in Firebase console > App Check > Manage debug tokens)
        if (import.meta.env.DEV) self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
        initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
    }
    db = getFirestore(app);
    // Local testing against the Firestore emulator (e.g. VITE_FIRESTORE_EMULATOR=127.0.0.1:8080):
    // nothing is read from or written to the real database
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
