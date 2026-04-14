# Design: Institute Grouping — Scuole Accorpate in input.xlsx

**Data:** 2026-04-14

## Problema

In alcuni test case di `realSuite`, il file `groundtruth.xlsx` (foglio `Dettaglio Completo`) contiene righe di scuole con `Luogo Ritrovo` e/o `Persone` vuoti. Questo significa che la scuola condivide la fermata (e il bus) della scuola nella riga precedente. Esempio nel caso Padel:

- **IS ENAIP di TIONE** — FIN#2, `07:50`, `Tione, Via Durone 53`, 17 pax
- **IS GUETTI** — FIN#2, (vuoto), (vuoto), (vuoto) → stessa fermata di IS ENAIP di TIONE

La funzione `extract_schools_from_structured()` in `prepare_realSuite.py` eliminava queste righe (drop su `Indirizzo` NaN), per cui scuole come IS GUETTI e IS FILZI ROVERETO non entravano mai in `input.xlsx`. L'optimizer non le conosceva e il confronto col groundtruth risultava penalizzato.

Casi affetti: **15 su 30** test case nel realSuite.

## Soluzione scelta: Opzione A — foglio `Dettaglio Completo` con forward-fill

### Componente 1: fix di `extract_schools_from_structured()` (`prepare_realSuite.py`)

Cambio il foglio sorgente da `Per Istituto` a `Dettaglio Completo`.

**Motivazione:** `Dettaglio Completo` ha l'ordine cronologico per bus (prima tutte le fermate del bus 1, poi del bus 2, ecc.), quindi un forward-fill globale su `FIN #` e `Luogo Ritrovo` è non ambiguo: ogni scuola senza indirizzo eredita sempre e solo dal suo predecessore corretto sullo stesso bus.

`Per Istituto` è ordinato alfabeticamente per nome scuola, quindi un forward-fill non funzionerebbe per bus con più fermate distinte.

**Modifiche alla funzione:**

```python
df = pd.read_excel(xlsx_path, sheet_name="Dettaglio Completo")
df.columns = [c.strip() for c in df.columns]

# Propaga FIN# e indirizzo di fermata alle scuole accorpate
df["FIN #"]         = df["FIN #"].ffill()
df["Luogo Ritrovo"] = df["Luogo Ritrovo"].ffill()

out = pd.DataFrame({
    "Nome":        df["Istituto"].astype(str).str.strip(),
    "Indirizzo":   df["Luogo Ritrovo"].astype(str).str.strip(),
    "Partecipanti": pd.to_numeric(df["Persone"], errors="coerce").fillna(0).astype(int),
})

# Scarta righe senza nome scuola (footer/righe vuote)
out = out[out["Nome"].notna() & (out["Nome"] != "") & (out["Nome"].str.lower() != "nan")]
out = out[out["Indirizzo"].notna() & (out["Indirizzo"] != "") & (out["Indirizzo"].str.lower() != "nan")]

# Deduplicazione invariata: stesso (Nome, Indirizzo) → somma Partecipanti
out = out.groupby(["Nome", "Indirizzo"], as_index=False).agg({"Partecipanti": "sum"})
out["Partecipanti"] = out["Partecipanti"].astype(int)
```

**Comportamento per Persone vuoto:** `fillna(0)` → `Partecipanti=0`. La scuola appare nell'optimizer come nodo a domanda zero (non impatta la capacità, ma compare nel confronto col groundtruth).

**Scuole con più fermate reali** (es. IC LADINO DI FASSA con 3 stop in Valsugana): la deduplicazione `groupby(["Nome", "Indirizzo"])` le mantiene come nodi distinti, comportamento corretto e invariato rispetto a prima.

La firma pubblica della funzione (`xlsx_path → pd.DataFrame[Nome, Indirizzo, Partecipanti]`) non cambia.

### Componente 2: cascade di rigenerazione artefatti

Dopo il fix, un helper script (o passi manuali) per i casi modificati:

1. `prepare_realSuite.py --extract` — sovrascrive `input.xlsx` per tutti i casi
2. Elimina `input_corretto.xlsx` nei soli casi in cui `input.xlsx` è cambiato
3. Elimina `coords.json` + `time_matrix.json` negli stessi casi (`run_geocode` è idempotente, salta se i file esistono)
4. `prepare_realSuite.py --correct` — ri-corregge gli indirizzi (salta i già corretti)
5. `prepare_realSuite.py --geocode` — ri-geocodifica (salta i già presenti)
6. `python tools/run_compare.py` — rigenera i JSON del compare tool

**Nota:** le scuole ereditate hanno lo stesso indirizzo del parent già corretto dall'AI, quindi la re-correction è rapida e non introduce regressioni.

### Componente 3: aggiornamento test

- `tests/test_prepare_realSuite.py`: aggiornare i test che si aspettano lo scarto di righe con indirizzo vuoto — ora devono aspettarsi l'inclusione con indirizzo ereditato.
- Aggiungere un test esplicito: fixture con riga "accorpata" (Luogo Ritrovo NaN) → verifica che la scuola compaia in output con l'indirizzo del predecessore e `Partecipanti` corretto (0 se vuoto).
- `tests/test_realSuite.py` (`test_all_schools_assigned`) passerà automaticamente dopo la rigenerazione degli artefatti.

## Impatto atteso

Aggiungere le scuole mancanti all'optimizer aumenterà il numero di nodi da ottimizzare per i casi affetti. Poiché le scuole ereditate hanno la stessa coordinata del parent (stessa fermata → 0 distanza), l'optimizer le raggruppa naturalmente sullo stesso bus senza bisogno di modificare la logica del solver. I punteggi di assignment nel compare tool dovrebbero migliorare.
