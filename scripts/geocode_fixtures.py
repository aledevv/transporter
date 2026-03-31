"""
Run once to generate geocoded coordinate fixtures for real test datasets.
Results are saved to tests/real1/coords.json and tests/real2/coords.json
and committed to the repo so tests run without network access.

Usage: ./venv/bin/python3 scripts/geocode_fixtures.py
"""
import sys
import json
import pandas as pd

sys.path.insert(0, '.')
from app import smart_geocode

DATASETS = ['real1', 'real2']

for dataset in DATASETS:
    path = f'tests/{dataset}/input.xlsx'
    df = pd.read_excel(path)
    name_col = 'Nome' if 'Nome' in df.columns else 'Nome (della scuola)'

    coords = {}
    print(f'\n=== {dataset} ({len(df)} schools) ===')
    for _, row in df.iterrows():
        name = str(row[name_col]).strip()
        address = str(row['Indirizzo']).strip()
        lat, lon, ok = smart_geocode(address, school_name=name)
        coords[name] = {'lat': lat, 'lon': lon, 'geocoded': ok}
        status = '✓' if ok else '✗ fallback'
        print(f'  {status}  {name}: ({lat:.4f}, {lon:.4f})')

    out_path = f'tests/{dataset}/coords.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(coords, f, indent=2, ensure_ascii=False)
    print(f'Saved {out_path}')
