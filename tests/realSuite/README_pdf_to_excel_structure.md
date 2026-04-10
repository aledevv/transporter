
# Pipeline PDF → JSON/Excel per piani di viaggio trasporti

## Overview

La pipeline elabora documenti dei "piani di viaggio" (PDF già convertiti in testo) e produce, per ogni evento sportivo scolastico, una struttura dati JSON normalizzata e un file Excel di ground truth.

### Obiettivo

- **Input logico**: testo estratto dal PDF (es. via `pdfplumber`/`pdftotext`) che contiene:
  - intestazione dell'evento (sport, categoria, data, destinazione, orari);
  - una o più tabelle di trasporto con righe per ciascun bus (FIN) e relative fermate.
- **Output**:
  - `*.json` con struttura dati coerente per tutti gli eventi;
  - `*.xlsx` con due fogli:
    - `Dettaglio Completo` (event-centric, una riga per fermata); 
    - `Per Istituto` (school-centric, una riga per fermata ordinata per istituto/data/FIN).

L'LLM che userà questi script riceverà **in locale** il testo già estratto dal PDF e dovrà solo occuparsi di popolare la struttura dati `data` (vedi schema sotto) e poi richiamare le funzioni di serializzazione JSON/Excel.

---

## Struttura dati di output

La struttura principale è un dizionario Python `data` con questa forma:

```python
{
  "events": [
    {
      "event_id": str,              # ID univoco leggibile (es. "CALCIO_A5_CADETTI_170325")
      "sport": str,                 # es. "CALCIO A5", "ATLETICA LEGGERA"
      "categoria": str,            # es. "Cadetti", "Istituti Superiori"
      "data": str,                 # ISO date YYYY-MM-DD
      "destinazione": str,        # descrizione completa destinazione
      "orario_ritrovo": str|null, # "HH:MM" se noto
      "orario_fine_manifestazione": str|null,  # "HH:MM" se noto
      "autonomi": [str, ...],      # elenco di istituti che raggiungono in autonomia

      "bus_groups": [
        {
          "fin": str,              # identificativo bus, es. "1", "5 bis", "Fin 3"
          "ditta": str|null,       # nome vettore (se presente nel PDF)
          "ditta_tel": str|null,   # telefono/tel/cell del vettore
          "km": int|float|null,    # chilometraggio dichiarato (se noto)
          "totale_pax": int|null,  # TOTALE PAX del bus se leggibile
          "note": str|null,        # commenti su ambiguità/assunzioni

          "fermate": [
            {
              "istituto": str,             # nome istituto o dicitura (es. "IS MARTINI + Students Staff")
              "orario_partenza": str|null, # "HH:MM" o formati originali tipo "7,45" normalizzati
              "luogo_ritrovo": str|null,   # testo libero del luogo di ritrovo
              "persone": int|null,         # numero persone trasportate
              "rientro_presunto": str|null # orario di rientro se presente
            },
            ...
          ]
        },
        ...
      ]
    },
    ...
  ]
}
```

### Principi di modellazione

1. **Evento come radice logica**: ogni PDF di solito contiene **un evento**; in rari casi potrebbe contenerne più d’uno, ma la struttura `events[]` supporta entrambi i casi.
2. **Bus-group = FIN**: la tabella per i trasporti è raggruppata per FIN (numero bus) e km/ditta; ogni FIN può servire più fermate/istituti.
3. **Fermata atomica**: ogni riga logica di istituto/fermata nel PDF diventa un elemento di `fermate[]`.
4. **Campi mancanti**: se il PDF non fornisce in maniera non ambigua orario/luogo/rientro per una sotto‑righe (es. solo aggiunta di istituto + persone), **non si inventano dati**; si valorizza solo ciò che è esplicito (tipicamente `istituto` e `persone`), lasciando `None`/vuoto il resto.
5. **Totale PAX come verità locale**: il campo `totale_pax` del bus è copiato dal PDF e non ricalcolato; se la somma delle fermate non torna per ambiguità, si documenta la cosa in `note`.

---

## Struttura degli Excel

Dato un oggetto `data` come sopra, lo script produce un file Excel con **due fogli**.

### 1. Foglio "Dettaglio Completo"

- Una riga per ogni fermata (`fermate[]`), con le informazioni ripetute per l’evento e per il bus (solo sulla prima riga della FIN per leggibilità).
- Intestazioni:

```text
Evento ID | Sport | Categoria | Data | Destinazione | Orario Ritrovo | Fine Manifestazione |
FIN # | Ditta | Tel Ditta | Km | Totale PAX Bus | Note Bus |
Istituto | Orario Partenza | Luogo Ritrovo | Persone | Rientro Presunto
```

- Per la **prima fermata** di ogni FIN si valorizzano anche: `Evento ID`, `Sport`, `Categoria`, `Data`, `Destinazione`, `Orario Ritrovo`, `Fine Manifestazione`, `FIN #`, `Ditta`, `Tel Ditta`, `Km`, `Totale PAX Bus`, `Note Bus`.
- Per le **fermate successive** dello stesso FIN si compilano solo le colonne della fermata (`Istituto`, `Orario Partenza`, `Luogo Ritrovo`, `Persone`, `Rientro Presunto`), lasciando vuote le colonne evento/bus per migliore leggibilità.
- Stile:
  - righe alternate bianco/azzurro (`WHITE_FILL` / `ALT_FILL`) per leggibilità;
  - bordo sottile su ogni cella;
  - testo centrato per campi chiave (orari, km, FIN, persone) e allineato a sinistra per testi lunghi (destinazione, luogo, note).

### 2. Foglio "Per Istituto"

- Una riga per fermata, ma **orientata per istituto**.
- Intestazioni tipiche:

```text
Sport | Data | Categoria | Destinazione | FIN # | Istituto |
Orario Partenza | Luogo Ritrovo | Persone | Rientro Presunto
```

- Ogni riga contiene:
  - Info evento: `Sport`, `Data`, `Categoria`, `Destinazione`.
  - Info bus: `FIN #`.
  - Info fermata: `Istituto`, `Orario Partenza`, `Luogo Ritrovo`, `Persone`, `Rientro Presunto`.
- Ordinamento righe:

```python
rows.sort(key=lambda x: (str(x[5]), str(x[1]), str(x[4])))
# cioè: per nome istituto, poi data, poi FIN
```

Questo rende facile filtrare/ricercare tutti i viaggi di un dato istituto.

---

## Flusso logico suggerito per un LLM

L’LLM che usa questi script dovrebbe seguire questa sequenza:

1. **Input**: riceve (dal chiamante) il testo estratto dal PDF.
2. **Parsing della testata evento**:
   - trovare righe tipo:
     - sport + categoria (es. "CALCIO A5 – Cadetti");
     - data (es. "17 marzo 2025");
     - destinazione (es. "DESTINAZIONE: CENTRO SPORTIVO MELTA DI GARDOLO");
     - orario ritrovo e fine manifestazione (es. "ritrovo ore 8,15" / "fine manifestazione ore 16,00").
   - normalizzare la data in `YYYY-MM-DD`.
3. **Parsing delle tabelle bus (FIN)**:
   - individuare blocchi che iniziano con `FIN`, `Fin`, o `N° Ditta/Km` a seconda del formato;
   - estrarre per ciascun blocco:
     - `fin` (può includere suffissi come "bis");
     - ditta e telefono (se presenti);
     - km (dopo "KM" o similare);
     - righe istituti: per ogni riga completata, estrarre `istituto`, `orario_partenza`, `luogo_ritrovo`, `persone`, `rientro_presunto`.
   - identificare la riga `TOTALE PAX` e memorizzarne il valore in `totale_pax` del bus.
4. **Gestione casi ambigui**:
   - se l’istituto appare senza orario/luogo/rientro ma solo come estensione del bus, compilare `istituto` e `persone` e lasciare gli altri campi `None`; 
   - aggiungere una nota in `note` del bus quando dal testo emergono fraintendimenti possibili (es. numeri isolati prima del rientro, righe mal spezzate).
5. **Eventuali istituti "in autonomia"**:
   - cercare righe a fine documento tipo "Raggiungeranno la sede in autonomia:" e popolare `autonomi` con l’elenco di quegli istituti.
6. **Serializzazione**:
   - costruire `data = {"events": [evento]}`;
   - passare `data` alle funzioni di salvataggio per JSON ed Excel.

---

## API principali nello script Python

Le funzioni chiave che l’LLM deve conoscere/riusare/adattare sono:

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from datetime import datetime

HDR_FILL = PatternFill('solid', fgColor='1F4E79')
HDR_FONT = Font(name='Calibri', bold=True, color='FFFFFF', size=11)
ALT_FILL = PatternFill('solid', fgColor='EBF3FB')
WHITE_FILL = PatternFill('solid', fgColor='FFFFFF')
NORM_FONT = Font(name='Calibri', size=10)
CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
LEFT = Alignment(horizontal='left', vertical='center', wrap_text=True)
thin = Side(style='thin', color='B8CCE4')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def style_cell(cell, font=None, fill=None, align=None, border=None):
    if font:
        cell.font = font
    if fill:
        cell.fill = fill
    if align:
        cell.alignment = align
    if border:
        cell.border = border


def make_excel(path: str, data: dict) -> None:
    """Crea l'Excel di ground truth a partire dalla struttura `data`.

    - path: percorso del file `.xlsx` da salvare.
    - data: struttura come definita nella sezione "Struttura dati di output".
    """
    wb = Workbook()

    # --- Foglio 1: Dettaglio Completo ---
    ws1 = wb.active
    ws1.title = 'Dettaglio Completo'

    headers = [
        'Evento ID','Sport','Categoria','Data','Destinazione',
        'Orario Ritrovo','Fine Manifestazione',
        'FIN #','Ditta','Tel Ditta','Km','Totale PAX Bus','Note Bus',
        'Istituto','Orario Partenza','Luogo Ritrovo','Persone','Rientro Presunto'
    ]

    for col, h in enumerate(headers, 1):
        cell = ws1.cell(row=1, column=col, value=h)
        style_cell(cell, font=HDR_FONT, fill=HDR_FILL, align=CENTER, border=BORDER)

    row_idx = 2
    alt = False

    for ev in data['events']:
        for bg in ev['bus_groups']:
            for i, f in enumerate(bg['fermate']):
                fill = ALT_FILL if alt else WHITE_FILL

                values = [
                    ev['event_id'] if i == 0 else '',
                    ev['sport'] if i == 0 else '',
                    ev['categoria'] if i == 0 else '',
                    ev['data'] if i == 0 else '',
                    ev['destinazione'] if i == 0 else '',
                    ev.get('orario_ritrovo') if i == 0 else '',
                    ev.get('orario_fine_manifestazione') if i == 0 else '',
                    bg['fin'] if i == 0 else '',
                    bg.get('ditta') if i == 0 else '',
                    bg.get('ditta_tel') if i == 0 else '',
                    bg.get('km') if i == 0 else '',
                    bg.get('totale_pax') if i == 0 else '',
                    bg.get('note') if i == 0 else '',
                    f.get('istituto'),
                    f.get('orario_partenza'),
                    f.get('luogo_ritrovo'),
                    f.get('persone'),
                    f.get('rientro_presunto'),
                ]

                for col, val in enumerate(values, 1):
                    cell = ws1.cell(row=row_idx, column=col, value=val)
                    align = CENTER if col in [1,2,3,4,6,7,8,11,12,15,17,18] else LEFT
                    style_cell(cell, font=NORM_FONT, fill=fill, align=align, border=BORDER)

                row_idx += 1

            alt = not alt

    # larghezza colonne (adattare se necessario)
    widths = [22,16,26,12,55,14,16,8,18,15,8,12,42,30,14,52,10,14]
    for col, w in enumerate(widths, 1):
        ws1.column_dimensions[get_column_letter(col)].width = w

    ws1.freeze_panes = 'A2'

    # --- Foglio 2: Per Istituto ---
    ws2 = wb.create_sheet('Per Istituto')

    headers2 = [
        'Sport','Data','Categoria','Destinazione',
        'FIN #','Istituto','Orario Partenza','Luogo Ritrovo','Persone','Rientro Presunto'
    ]

    for col, h in enumerate(headers2, 1):
        cell = ws2.cell(row=1, column=col, value=h)
        style_cell(cell, font=HDR_FONT, fill=HDR_FILL, align=CENTER, border=BORDER)

    rows = []
    for ev in data['events']:
        for bg in ev['bus_groups']:
            for f in bg['fermate']:
                rows.append([
                    ev['sport'],
                    ev['data'],
                    ev['categoria'],
                    ev['destinazione'],
                    bg['fin'],
                    f.get('istituto'),
                    f.get('orario_partenza'),
                    f.get('luogo_ritrovo'),
                    f.get('persone'),
                    f.get('rientro_presunto'),
                ])

    # ordinamento principale: istituto, data, FIN
    rows.sort(key=lambda x: (str(x[5]), str(x[1]), str(x[4])))

    for idx, row in enumerate(rows, start=2):
        fill = ALT_FILL if idx % 2 == 0 else WHITE_FILL
        for col, val in enumerate(row, 1):
            cell = ws2.cell(row=idx, column=col, value=val)
            align = CENTER if col in [1,2,5,7,9,10] else LEFT
            style_cell(cell, font=NORM_FONT, fill=fill, align=align, border=BORDER)

    # footer informativo
    for ws in wb.worksheets:
        r = ws.max_row + 2
        ws.cell(r, 1, f"Generato il: {datetime.now().strftime('%Y-%m-%d')} | Fonte: estrazione da PDF")

    wb.save(path)


def save_pair(base_name: str, data: dict, out_dir: str = 'output'):
    """Salva JSON + Excel con lo stesso nome base.

    - base_name: nome base del file (senza estensione PDF);
    - data: struttura `data`;
    - out_dir: directory di output (default: 'output').
    """
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    json_path = Path(out_dir) / f"{base_name}_structured.json"
    xlsx_path = Path(out_dir) / f"{base_name}_structured.xlsx"

    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    make_excel(str(xlsx_path), data)

    return str(json_path), str(xlsx_path)
```

### Come adattare gli script

- Per un nuovo tipo di evento/PDF:
  1. il tuo LLM di parsing deve costruire `data` secondo lo schema;
  2. scegliere `base_name` coerente con il nome del PDF di origine;
  3. chiamare `save_pair(base_name, data, out_dir='output_groundtruth')`.
- Puoi usare la **stessa funzione `make_excel`** per tutti gli sport/eventi.
- Se cambiano alcune colonne o vuoi campi extra (es. ditta/km anche nel foglio "Per Istituto"), basta modificare:
  - la lista `headers`/`headers2`;
  - l’ordine dei valori in `values` e `rows.append([...])`.

---

## Uso tipico (pseudo‑codice)

```python
from parser_mod import parse_pdf_text  # il tuo parser basato su LLM
from exporter import save_pair

pdf_text = extract_text('Piano-Viaggi_Atletica-IS_7-maggio-2025_def_con-cell.pdf')

# 1) Parsing logico del PDF (fatto da LLM o da regole custom)
data = parse_pdf_text(pdf_text)

# 2) Esportazione ground truth
json_path, xlsx_path = save_pair(
    base_name='Piano-Viaggi_Atletica-IS_7-maggio-2025_def_con-cell',
    data=data,
    out_dir='output_groundtruth'
)

print(json_path, xlsx_path)
```

Il tuo "test case" potrà quindi:
- prendere un PDF sorgente;
- generare in automatico, con un LLM, una struttura `data_pred`;
- confrontarla con il `*_structured.json`/`*.xlsx` di ground truth prodotto con questi script (stesso schema) per valutare la qualità del parsing (precision/recall su fermate, orari, persone, ecc.).
