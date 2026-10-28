import * as maplibregl from 'maplibre-gl';

// Map credits as an "i" toggle in the bottom-right corner, closed at start.
// MapLibre opens the compact attribution by itself as soon as the credits
// arrive (often after 'load'), so it is kept closed until the user first
// presses the button; from then on the button simply opens and closes it.
export function addCollapsedAttribution(map) {
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    const box = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    if (!box) return;
    // only touch the class when needed: any classList write is itself a mutation
    const close = () => { if (box.classList.contains('maplibregl-compact-show')) box.classList.remove('maplibregl-compact-show'); };
    const observer = new MutationObserver(close);
    observer.observe(box, { attributes: true, attributeFilter: ['class'] });
    close();
    box.addEventListener('click', () => observer.disconnect(), { capture: true, once: true });
    map.once('remove', () => observer.disconnect());
}
