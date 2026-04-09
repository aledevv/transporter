# Map Pin Participants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrare il numero di partecipanti direttamente sul pin della mappa: goccia con numero per fermate normali, cerchio con icona scuola per istituti.

**Architecture:** Aggiungere due nuove funzioni icon factory in `Map.jsx` (`createStopIcon`, `createInstituteIcon`) che generano `L.divIcon` con HTML/CSS puro. La funzione `createCustomIcon` esistente rimane solo per il pin destinazione. Il render dei marker scuola sceglie tra le due nuove factory in base a `school.institute`.

**Tech Stack:** React 18, Leaflet / react-leaflet, lucide-react (`GraduationCap`), `renderToStaticMarkup` (già importato)

---

### Task 1: Aggiungere `createStopIcon` e `createInstituteIcon` a Map.jsx

**Files:**
- Modify: `frontend/src/components/Map.jsx`

- [ ] **Step 1: Aggiungere `GraduationCap` all'import lucide-react**

In `Map.jsx` riga 8, sostituire:
```js
import { MapPin, Flag, Building2 } from 'lucide-react';
```
con:
```js
import { Flag, GraduationCap } from 'lucide-react';
```
(`MapPin` e `Building2` non sono più usati dopo questa modifica.)

- [ ] **Step 2: Aggiungere `createStopIcon` dopo la riga `const EASING = ...`**

Inserire subito dopo riga 11 (`const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';`):

```js
const createStopIcon = (color, demand) => {
    const fontSize = demand >= 100 ? '10px' : demand >= 10 ? '12px' : '14px';
    const html = `
        <div style="position:relative;width:36px;height:44px;">
            <div style="
                width:36px;height:36px;
                border-radius:50% 50% 50% 0;
                transform:rotate(-45deg);
                background:${color};
                border:2px solid white;
                box-shadow:0 3px 10px rgba(0,0,0,0.25);
                display:flex;align-items:center;justify-content:center;
            ">
                <span style="
                    transform:rotate(45deg);
                    color:white;
                    font-size:${fontSize};
                    font-weight:800;
                    line-height:1;
                    font-family:sans-serif;
                ">${demand}</span>
            </div>
            <div style="
                position:absolute;bottom:0;left:50%;
                transform:translateX(-50%);
                width:10px;height:5px;
                background:rgba(0,0,0,0.15);
                border-radius:50%;
                filter:blur(2px);
            "></div>
        </div>`;
    return L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [36, 44],
        iconAnchor: [18, 44],
        popupAnchor: [0, -44],
    });
};
```

- [ ] **Step 3: Aggiungere `createInstituteIcon` subito dopo `createStopIcon`**

```js
const createInstituteIcon = (color) => {
    const iconHtml = renderToStaticMarkup(
        <GraduationCap
            style={{ width: 22, height: 22, color: 'white', strokeWidth: 2 }}
        />
    );
    const html = `
        <div style="
            width:40px;height:40px;
            border-radius:50%;
            background:${color};
            border:3px solid white;
            box-shadow:0 3px 10px rgba(0,0,0,0.25);
            display:flex;align-items:center;justify-content:center;
        ">${iconHtml}</div>`;
    return L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
    });
};
```

- [ ] **Step 4: Aggiornare la riga `createCustomIcon` per il pin destinazione**

La riga 32 attuale:
```js
const destinationIcon = createCustomIcon('#ef4444', Flag);
```
rimane invariata — `createCustomIcon` non viene toccata.

- [ ] **Step 5: Aggiornare la logica di rendering dei marker scuola**

Trovare nel render (circa riga 309–314) il blocco:
```js
const color = school.institute
    ? (instituteColorMap[school.institute] || '#3b82f6')
    : '#3b82f6';
const icon = createCustomIcon(color, school.institute ? Building2 : MapPin);
```
Sostituire con:
```js
const color = school.institute
    ? (instituteColorMap[school.institute] || '#3b82f6')
    : '#3b82f6';
const icon = school.institute
    ? createInstituteIcon(color)
    : createStopIcon(color, school.demand);
```

- [ ] **Step 6: Verificare che il frontend compili senza errori**

```bash
cd frontend && npm run build
```
Atteso: build completata senza errori. Se ci sono warning su `MapPin`/`Building2` unused, sono già stati rimossi all'Step 1.

- [ ] **Step 7: Avviare in dev e verificare visivamente**

```bash
./start.sh
```
Aprire `http://localhost:5173`, caricare un file Excel con dati, e verificare:
- Fermate senza istituto → pin a goccia con numero al centro
- Fermate con istituto → cerchio piatto con icona cappello
- Click su qualsiasi marker → Popup con dettagli invariato
- Pin destinazione → Flag rossa invariata

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/Map.jsx
git commit -m "feat: show participant count on map pins, circle icon for institutes"
```
