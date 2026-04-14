# Institute Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere le scuole "accorpate" (Luogo Ritrovo vuoto) a `input.xlsx` propagando l'indirizzo del predecessore, così l'optimizer le conosce e il confronto col groundtruth è corretto.

**Architecture:** Il fix è in `extract_schools_from_structured()` in `prepare_realSuite.py`: si cambia foglio sorgente da `Per Istituto` a `Dettaglio Completo` e si aggiunge forward-fill su `FIN #` e `Luogo Ritrovo`. I 15 test case affetti hanno poi gli artefatti rigenerati in cascade.

**Tech Stack:** Python, pandas, openpyxl, pytest. Geocoder via Nominatim/OSRM (nessuna API key). AI correction via Gemini (richiede `GOOGLE_API_KEY`, opzionale).

---

## File Map

| File | Azione |
|---|---|
| `tests/prepare_realSuite.py` | **Modify** — `extract_schools_from_structured()` righe 28-54 |
| `tests/test_prepare_realSuite.py` | **Modify** — aggiornare test esistente + aggiungere test ereditarietà |
| `tests/realSuite/*/input.xlsx` | **Regenerate** via `--extract` |
| `tests/realSuite/*/input_corretto.xlsx` | **Delete** per i casi modificati, poi rigenerare |
| `tests/realSuite/*/coords.json` | **Delete** per i casi modificati, poi rigenerare |
| `tests/realSuite/*/time_matrix.json` | **Delete** per i casi modificati, poi rigenerare |
| `tools/compare/data/*.json` | **Regenerate** via `tools/run_compare.py` |

---

## Task 1: Fix `extract_schools_from_structured()` con TDD

**Files:**
- Modify: `tests/prepare_realSuite.py:28-54`
- Modify: `tests/test_prepare_realSuite.py`

- [ ] **Step 1: Aggiungi il test di ereditarietà (failing)**

In `tests/test_prepare_realSuite.py` aggiungere in fondo:

```python
# Padel ha IS GUETTI (Luogo Ritrovo=NaN) e IS FILZI ROVERETO (Luogo Ritrovo=NaN)
PADEL = REALSUITE / "archive" / "Piani-viaggio_Padel_10-dic-25_def2_con-VETTORE_structured.xlsx"

def test_extract_schools_includes_grouped_schools():
    """Scuole con Luogo Ritrovo vuoto ereditano l'indirizzo del predecessore."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    names = df["Nome"].tolist()
    assert "IS GUETTI" in names, f"IS GUETTI mancante; scuole trovate: {names}"
    assert "IS FILZI ROVERETO" in names, f"IS FILZI ROVERETO mancante; scuole trovate: {names}"

def test_extract_schools_grouped_school_inherits_address():
    """IS GUETTI eredita l'indirizzo di IS ENAIP di TIONE."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    guetti = df[df["Nome"] == "IS GUETTI"]
    assert len(guetti) == 1
    expected = "Tione, Via Durone 53 – fermata davanti alla scuola I.I.L. Guetti"
    assert guetti.iloc[0]["Indirizzo"] == expected, (
        f"Indirizzo errato: {guetti.iloc[0]['Indirizzo']!r}"
    )

def test_extract_schools_grouped_school_zero_demand():
    """IS GUETTI ha Persone=NaN → Partecipanti=0."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    guetti = df[df["Nome"] == "IS GUETTI"]
    assert guetti.iloc[0]["Partecipanti"] == 0

def test_extract_schools_grouped_school_with_demand():
    """IS FILZI ROVERETO ha Persone=9 → Partecipanti=9."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    filzi = df[df["Nome"] == "IS FILZI ROVERETO"]
    assert filzi.iloc[0]["Partecipanti"] == 9
```

- [ ] **Step 2: Verifica che i test falliscano**

```bash
cd /Users/dev/Desktop/busplan && source venv/bin/activate
pytest tests/test_prepare_realSuite.py -v -k "grouped"
```

Output atteso: `FAILED` (4 test) — `IS GUETTI` non trovata perché la funzione attuale scarta le righe senza indirizzo.

- [ ] **Step 3: Implementa il fix in `extract_schools_from_structured()`**

In `tests/prepare_realSuite.py`, sostituire l'intera funzione `extract_schools_from_structured` (righe 28-54) con:

```python
def extract_schools_from_structured(xlsx_path: Path) -> pd.DataFrame:
    """
    Read the 'Dettaglio Completo' sheet and return a DataFrame with columns:
      Nome, Indirizzo, Partecipanti
    Schools with empty Luogo Ritrovo inherit the address of the preceding stop
    on the same bus (forward-fill). Schools with empty Persone get Partecipanti=0.
    Deduplicates by (Nome, Indirizzo), summing Partecipanti.
    NO Istituto grouping column — planner must discover proximity itself.
    """
    df = pd.read_excel(xlsx_path, sheet_name="Dettaglio Completo")
    df.columns = [c.strip() for c in df.columns]

    # Propagate FIN# and pickup address to grouped schools (same stop, same bus)
    df["FIN #"]         = df["FIN #"].ffill()
    df["Luogo Ritrovo"] = df["Luogo Ritrovo"].ffill()

    out = pd.DataFrame({
        "Nome":         df["Istituto"].astype(str).str.strip(),
        "Indirizzo":    df["Luogo Ritrovo"].astype(str).str.strip(),
        "Partecipanti": pd.to_numeric(df["Persone"], errors="coerce").fillna(0),
    })

    # Drop rows with no school name or no address (footer/empty rows)
    out = out[out["Nome"].notna() & (out["Nome"] != "") & (out["Nome"].str.lower() != "nan")]
    out = out[out["Indirizzo"].notna() & (out["Indirizzo"] != "") & (out["Indirizzo"].str.lower() != "nan")]

    # Deduplicate: same (Nome, Indirizzo) → sum Partecipanti
    out = out.groupby(["Nome", "Indirizzo"], as_index=False).agg({"Partecipanti": "sum"})
    out["Partecipanti"] = out["Partecipanti"].astype(int)

    return out.reset_index(drop=True)
```

- [ ] **Step 4: Esegui tutta la suite dei test**

```bash
pytest tests/test_prepare_realSuite.py -v
```

Output atteso: tutti `PASSED`. In particolare:
- `test_extract_schools_drops_null_rows` — ancora verde (nessun NaN dopo fill + drop)
- `test_extract_schools_partecipanti_is_int` — ancora verde
- `test_extract_schools_no_istituto_column` — ancora verde
- i 4 nuovi test — `PASSED`

- [ ] **Step 5: Commit**

```bash
git add tests/prepare_realSuite.py tests/test_prepare_realSuite.py
git commit -m "fix(prepare): include grouped schools via Dettaglio Completo forward-fill"
```

---

## Task 2: Rigenera `input.xlsx` per tutti i test case

**Files:**
- Regenerate: `tests/realSuite/*/input.xlsx`

- [ ] **Step 1: Esegui la fase di extract**

```bash
cd /Users/dev/Desktop/busplan && source venv/bin/activate
python tests/prepare_realSuite.py --extract
```

Output atteso: una riga `[extract] <nome>: N schools → ...` per ogni caso. I casi affetti avranno N più alto di prima.

- [ ] **Step 2: Spot-check sul caso Padel**

```bash
python3 -c "
import pandas as pd
df = pd.read_excel('tests/realSuite/Piani-viaggio_Padel_10-dic-25_def2_con-VETTORE/input.xlsx')
print(f'Scuole: {len(df)}')
print(df['Nome'].tolist())
"
```

Output atteso: `Scuole: 10` (erano 8 prima). IS GUETTI e IS FILZI ROVERETO devono essere presenti.

- [ ] **Step 3: Commit dei nuovi `input.xlsx`**

```bash
git add tests/realSuite/
git commit -m "data(realSuite): regenerate input.xlsx with grouped schools included"
```

---

## Task 3: Pulisci gli artefatti stantii e rigenera coordinate e matrici

**Files:**
- Delete: `tests/realSuite/*/input_corretto.xlsx` (casi modificati)
- Delete: `tests/realSuite/*/coords.json` (casi modificati)
- Delete: `tests/realSuite/*/time_matrix.json` (casi modificati)
- Regenerate: tutti e tre via `--correct` / `--geocode`

- [ ] **Step 1: Script di pulizia — elimina artefatti dei casi modificati**

```bash
python3 - << 'EOF'
"""
Elimina input_corretto.xlsx, coords.json e time_matrix.json per i casi in cui
il nuovo input.xlsx contiene scuole non presenti in input_corretto.xlsx.
"""
import pandas as pd
from pathlib import Path

REALSUITE = Path("tests/realSuite")

cleaned = []
for ev_dir in sorted(REALSUITE.iterdir()):
    if not ev_dir.is_dir():
        continue
    inp = ev_dir / "input.xlsx"
    corretto = ev_dir / "input_corretto.xlsx"
    if not inp.exists():
        continue

    new_names = set(pd.read_excel(inp)["Nome"].astype(str).str.strip())

    stale = False
    if corretto.exists():
        old_names = set(pd.read_excel(corretto)["Nome"].astype(str).str.strip())
        if new_names - old_names:  # nuove scuole non presenti nel corretto
            stale = True
    else:
        stale = True  # nessun corretto → coords potrebbero essere basati su input.xlsx vecchio

    if stale:
        for f in [corretto, ev_dir / "coords.json", ev_dir / "time_matrix.json"]:
            if f.exists():
                f.unlink()
                print(f"  rimosso: {f}")
        cleaned.append(ev_dir.name)

print(f"\nCasi puliti ({len(cleaned)}):")
for n in cleaned:
    print(f"  {n}")
EOF
```

Output atteso: ~15 casi elencati con i file rimossi.

- [ ] **Step 2: (Opzionale) Rigenera `input_corretto.xlsx` via AI**

Richiede `GOOGLE_API_KEY`. Se non disponibile, saltare — `run_geocode` userà `input.xlsx` direttamente.

```bash
python tests/prepare_realSuite.py --correct
```

Output atteso: righe `[correct] <nome>: status=ok` per i casi puliti; `already corrected — skipping` per gli altri.

- [ ] **Step 3: Rigenera `coords.json` e `time_matrix.json`**

```bash
python tests/prepare_realSuite.py --geocode
```

Output atteso: righe `[geocode] <nome>: N schools geocoded.` per i casi puliti; `already done — skipping` per gli altri.

Attenzione: questo step chiama Nominatim (rate-limit: 1 req/s) e OSRM. Per ~15 casi con ~5-30 scuole ciascuno, impiegare qualche minuto.

- [ ] **Step 4: Spot-check coords Padel**

```bash
python3 -c "
import json
coords = json.loads(open('tests/realSuite/Piani-viaggio_Padel_10-dic-25_def2_con-VETTORE/coords.json').read())
print('Scuole geocodificate:', list(coords.keys()))
print('IS GUETTI' in coords, 'IS FILZI ROVERETO' in coords)
"
```

Output atteso: entrambe `True`.

- [ ] **Step 5: Commit degli artefatti rigenerati**

```bash
git add tests/realSuite/
git commit -m "data(realSuite): regenerate coords and time_matrix with grouped schools"
```

---

## Task 4: Rigenera i JSON del compare tool

**Files:**
- Regenerate: `tools/compare/data/*.json`

- [ ] **Step 1: Esegui `run_compare.py`**

```bash
cd /Users/dev/Desktop/busplan && source venv/bin/activate
python tools/run_compare.py
```

Output atteso: progress bar + tabella con punteggi per ogni evento. I casi affetti dovrebbero mostrare punteggi di assignment migliori rispetto a prima.

- [ ] **Step 2: Spot-check punteggio Padel**

```bash
python3 -c "
import json
data = json.loads(open('tools/compare/data/piani-viaggio-padel-10-dic-25-def2-con-vettore.json').read())
print('Scores:', data['scores'])
# Verifica che IS GUETTI e IS FILZI appaiano nei matched_pairs
for pair in data.get('matched_pairs', []):
    stops = [s['name'] for s in pair.get('planner', {}).get('stops', [])]
    if 'IS GUETTI' in stops or 'IS FILZI ROVERETO' in stops:
        print('Trovato pair con scuola accorpata:', stops)
"
```

- [ ] **Step 3: Commit**

```bash
git add tools/compare/data/
git commit -m "data(compare): regenerate comparison JSONs with grouped schools"
```

---

## Self-Review

**Spec coverage:**
- ✓ Fix `extract_schools_from_structured` → Task 1
- ✓ Rigenerazione `input.xlsx` → Task 2
- ✓ Pulizia e rigenerazione artefatti (corretto/coords/matrix) → Task 3
- ✓ Rigenerazione JSON compare tool → Task 4
- ✓ Update test → Task 1 steps 1-4

**Placeholder scan:** Nessun TBD/TODO. Tutti i passi hanno comandi o codice concreto.

**Type consistency:** `extract_schools_from_structured` restituisce sempre `pd.DataFrame[Nome, Indirizzo, Partecipanti]` — invariato.
