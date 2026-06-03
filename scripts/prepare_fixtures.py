"""
Run once to generate all test fixtures for real datasets, mirroring the full UI pipeline:
  1. AI address correction  (AddressCorrector — needs GOOGLE_API_KEY)
  2. Geocoding              (smart_geocode via Nominatim — needs network)
  3. Spiral jitter          (same logic as app.py process_file_task)
  4. Travel-time matrix     (GeocodingService.get_time_matrix — needs GOOGLE_MAPS_API_KEY)

Artifacts saved (commit these so tests run offline):
  tests/{dataset}/input_corretto.xlsx   — AI-corrected addresses
  tests/{dataset}/coords.json           — geocoded + jittered coordinates
  tests/{dataset}/time_matrix.json      — NxN travel-time matrix in seconds
                                          (node 0 = destination, 1..N = schools, no dummy)

Skip rules:
  • Address correction: skipped if input_corretto.xlsx already exists with AI_Corrected=True
  • Re-geocoding:       always runs (updates coords.json with corrected addresses)
  • Time matrix:        always runs (updates time_matrix.json)

Usage:
  ./venv/bin/python3 scripts/prepare_fixtures.py
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from app import smart_geocode
from data_loader import DataLoader
from geocoder import GeocodingService
from address_corrector import AddressCorrector, FLAG_COL

TESTS_DIR = Path(__file__).parent.parent / "tests"
TRENTO_LAT = 46.0707
TRENTO_LON = 11.1210

DATASETS = [
    {"name": "real1", "capacity": 56},
    {"name": "real2", "capacity": 55},
]


def _apply_jitter(lat, lon, used_coordinates):
    """
    Deterministic spiral jitter for overlapping coordinates.
    Identical to app.py process_file_task logic.
    """
    coord_key = (round(lat, 6), round(lon, 6))
    count = used_coordinates.get(coord_key, 0)
    if count > 0:
        angle = count * 2.4
        radius = 0.0003 * math.sqrt(count)
        lat += radius * math.sin(angle)
        lon += radius * math.cos(angle)
    used_coordinates[coord_key] = count + 1
    return lat, lon


def run_dataset(dataset_name):
    dataset_dir = TESTS_DIR / dataset_name
    input_path = dataset_dir / "input.xlsx"
    corrected_path = dataset_dir / "input_corretto.xlsx"
    coords_out = dataset_dir / "coords.json"
    matrix_out = dataset_dir / "time_matrix.json"

    print(f"\n{'=' * 60}")
    print(f"  Dataset: {dataset_name}")
    print(f"{'=' * 60}")

    # ------------------------------------------------------------------
    # Step 1: Address correction
    # ------------------------------------------------------------------
    skip_ai = False
    if corrected_path.exists():
        df_check = pd.read_excel(corrected_path)
        if FLAG_COL in df_check.columns and df_check[FLAG_COL].astype(bool).all():
            print(f"\n[Step 1] Reusing {corrected_path.name} (all rows AI_Corrected=True)")
            skip_ai = True

    if skip_ai:
        df_corrected = pd.read_excel(corrected_path)
        schools = [
            {
                "name": str(row["Nome"]).strip(),
                "address": str(row["Indirizzo"]).strip(),
                "demand": int(row["Partecipanti"]) if pd.notna(row["Partecipanti"]) else 0,
            }
            for _, row in df_corrected.iterrows()
        ]
    else:
        print(f"\n[Step 1] Running AddressCorrector on {input_path.name}...")
        original_data = DataLoader.load_data(str(input_path))
        original_schools = original_data["schools"]
        corrector = AddressCorrector()
        corrected_schools, status = corrector.correct_addresses(
            original_schools, str(input_path), str(corrected_path)
        )
        print(f"  Status: {status}")

        orig_map = {s["name"].strip(): s["address"] for s in original_schools}
        changed = 0
        for s in corrected_schools:
            name = s["name"].strip()
            orig = orig_map.get(name, "")
            if s["address"] != orig:
                changed += 1
                print(f"  CHANGED  {name}")
                print(f"    before: {orig}")
                print(f"    after:  {s['address']}")
        if changed == 0:
            print("  No address changes made.")

        # Strip names so they match what _load_dataset() looks up in coords.json
        schools = [
            {"name": s["name"].strip(), "address": s["address"], "demand": s["demand"]}
            for s in corrected_schools
        ]

    # ------------------------------------------------------------------
    # Step 2 + 3: Geocode corrected addresses + apply spiral jitter
    # ------------------------------------------------------------------
    print(f"\n[Step 2-3] Geocoding {len(schools)} schools (Nominatim) + applying jitter...")
    used_coordinates = {}
    geocoded = {}
    fallback_count = 0

    for school in schools:
        lat, lon, ok = smart_geocode(school["address"], school_name=school["name"])
        if not ok:
            fallback_count += 1
        lat, lon = _apply_jitter(lat, lon, used_coordinates)
        geocoded[school["name"]] = {"lat": lat, "lon": lon, "geocoded": ok}
        status_str = "✓" if ok else "✗ FALLBACK"
        print(f"  {status_str}  {school['name']}: ({lat:.4f}, {lon:.4f})")

    with open(coords_out, "w", encoding="utf-8") as f:
        json.dump(geocoded, f, indent=2, ensure_ascii=False)
    print(f"\n  Saved {coords_out} ({len(geocoded)} entries, {fallback_count} fallbacks)")

    # ------------------------------------------------------------------
    # Step 4: Build travel-time matrix via GeocodingService
    # ------------------------------------------------------------------
    print(f"\n[Step 4] Building travel-time matrix via GeocodingService...")
    geo_svc = GeocodingService()
    locations = [(TRENTO_LAT, TRENTO_LON)] + [(geocoded[s["name"]]["lat"], geocoded[s["name"]]["lon"]) for s in schools]
    matrix = geo_svc.get_time_matrix(locations)

    n = len(locations)
    print(f"  Matrix size: {n}x{n}  (node 0 = destination, 1..{n-1} = schools)")
    non_zero = sum(1 for i in range(n) for j in range(n) if matrix[i][j] > 0)
    print(f"  Non-zero entries: {non_zero} / {n*n - n} (expected ~{n*n - n})")

    # Check if fallback was used (all values suspiciously small / uniform)
    sample = [matrix[0][i] for i in range(1, min(4, n))]
    if sample:
        print(f"  Sample travel times from destination: {sample} seconds")

    with open(matrix_out, "w", encoding="utf-8") as f:
        json.dump(matrix, f)
    print(f"  Saved {matrix_out}")


def main():
    for ds in DATASETS:
        run_dataset(ds["name"])

    print(f"\n{'=' * 60}")
    print("  Done. Commit the following files:")
    for ds in DATASETS:
        name = ds["name"]
        print(f"    tests/{name}/input_corretto.xlsx")
        print(f"    tests/{name}/coords.json")
        print(f"    tests/{name}/time_matrix.json")
    print(f"\n  Then run: ./run_tests.sh")
    print(f"  And:      ./venv/bin/python3 scripts/compare_plans.py")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    main()
