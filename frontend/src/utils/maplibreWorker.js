import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre looks for its worker next to its own module file, which the bundle
// does not ship: without this the map stays blank ("Worker failed to load").
// Vite copies the worker into the build and gives us its URL.
setWorkerUrl(workerUrl);
