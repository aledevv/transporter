# Map Pin — Visualizzazione partecipanti

**Data:** 2026-04-09  
**Stato:** approvato

## Obiettivo

Mostrare il numero di partecipanti direttamente sul marker della mappa, senza dover cliccare. Il click continua ad aprire il Popup con i dettagli completi (nome, indirizzo, N passeggeri).

## Design

### Fermata normale (nessun istituto)

- Forma: **goccia** (teardrop CSS, `border-radius: 50% 50% 50% 0`, ruotata -45°)
- Contenuto: numero `demand` al centro, ruotato +45° per compensare
- Colore sfondo: blu `#3b82f6` (invariato rispetto a prima)
- Bordo: bianco 2px
- Dimensione: 36×36px
- Font scaling:
  - 1–2 cifre → 14px bold
  - 3 cifre → 10px bold (massimo atteso, non si va oltre)
- Ombra: ellisse sfocata sotto il pin

### Fermata con istituto

- Forma: **cerchio piatto** (border-radius 50%), senza coda
- Contenuto: icona scuola (GraduationCap da lucide-react) al centro
- Colore sfondo: colore dell'istituto da `instituteColorMap` (fallback `#3b82f6`)
- Bordo: bianco 3px
- Dimensione: 40×40px
- Nessun numero visibile — il count rimane nel Popup al click

### Pin destinazione

Invariato: icona Flag rossa, generata da `createCustomIcon` esistente.

## Modifiche a `Map.jsx`

### Nuove funzioni icon factory

```
createStopIcon(color, demand)   → L.divIcon goccia con numero
createInstituteIcon(color)      → L.divIcon cerchio con icona scuola
```

La funzione `createCustomIcon(color, IconComponent)` esistente rimane **solo** per il pin destinazione.

### Logica di scelta nel render

```js
const icon = school.institute
  ? createInstituteIcon(color)
  : createStopIcon(color, school.demand);
```

## Componenti coinvolti

| File | Tipo modifica |
|------|--------------|
| `frontend/src/components/Map.jsx` | Unico file modificato |

Nessun altro file cambia. La logica backend, i Popup, e il `instituteColorMap` rimangono invariati.

## Comportamento invariato

- Click su qualsiasi marker → Popup con nome, indirizzo, `N passeggeri`
- Colori per istituto (da `instituteColorMap`) invariati
- Pin destinazione (Flag rossa) invariato
- Tutti gli altri comportamenti della mappa (fullscreen, toggle rotte, ecc.) invariati
