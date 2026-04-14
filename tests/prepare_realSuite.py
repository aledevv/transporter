"""
Prepare realSuite test cases.

Usage:
  python tests/prepare_realSuite.py --extract          # Step 1: extract input.xlsx + groundtruth.xlsx
  python tests/prepare_realSuite.py --correct          # Step 2: AI-correct addresses (run once)
  python tests/prepare_realSuite.py --geocode          # Step 3: geocode + build time_matrix.json
  python tests/prepare_realSuite.py                    # Run all steps in sequence
"""
import argparse
import json
import math
import shutil
import sys
import warnings
from pathlib import Path

import pandas as pd

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
PENDING_DIR = REALSUITE_DIR / "pending"

# -----------------------------------------------------------------------
# Pure helper functions (unit-testable)
# -----------------------------------------------------------------------

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
    df["Luogo Ritrovo"] = df.groupby("FIN #")["Luogo Ritrovo"].transform("ffill")

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


def get_event_destination(xlsx_path: Path) -> str:
    """
    Return the destination string from the 'Per Istituto' sheet.
    Takes the first non-null value from the 'Destinazione' column.
    """
    df = pd.read_excel(xlsx_path, sheet_name="Per Istituto")
    df.columns = [c.strip() for c in df.columns]
    col = df["Destinazione"].dropna()
    col = col[col.astype(str).str.lower() != "nan"]
    if col.empty:
        return "Unknown"
    return str(col.iloc[0]).strip()


# -----------------------------------------------------------------------
# Phase 1: Extract
# -----------------------------------------------------------------------

def _event_name(xlsx_path: Path) -> str:
    """Folder name for an event: filename without '_structured.xlsx'."""
    return xlsx_path.stem.replace("_structured", "")


def _get_capacity(xlsx_path: Path) -> int:
    """
    Return the standard bus capacity for test cases.
    NOTE: 'Totale PAX Bus' in the groundtruth stores actual bus *load*, not physical
    capacity. We use 54 (standard Trentino school bus) unconditionally.
    """
    return 54


def _get_fine_manifestazione(xlsx_path: Path) -> str | None:
    """
    Extract event end time from 'Dettaglio Completo' sheet, 'Fine Manifestazione' column.
    Returns HH:MM string or None if absent.
    """
    import datetime
    try:
        df = pd.read_excel(xlsx_path, sheet_name="Dettaglio Completo")
        df.columns = [c.strip() for c in df.columns]
        if "Fine Manifestazione" in df.columns:
            col = df["Fine Manifestazione"].dropna()
            col = col[col.astype(str).str.lower() != "nan"]
            if not col.empty:
                val_raw = col.iloc[0]
                # Handle datetime objects before stringifying
                if isinstance(val_raw, datetime.time):
                    return val_raw.strftime("%H:%M")
                if hasattr(val_raw, 'strftime'):  # pd.Timestamp or datetime
                    return val_raw.strftime("%H:%M")
                val = str(val_raw).strip()
                # Normalize to HH:MM
                if ":" in val:
                    return val[:5]
    except Exception:
        pass
    return None


def run_extract():
    """Phase 1: extract input.xlsx + groundtruth.xlsx + config.json for each event."""
    structured_files = sorted(
        f for f in REALSUITE_DIR.glob("*_structured.xlsx")
        if not f.is_relative_to(PENDING_DIR)
    )

    if not structured_files:
        print("No _structured.xlsx files found in tests/realSuite/")
        return

    for xlsx in structured_files:
        name = _event_name(xlsx)
        out_dir = REALSUITE_DIR / name
        out_dir.mkdir(exist_ok=True)

        # Write input.xlsx
        df = extract_schools_from_structured(xlsx)
        df.to_excel(out_dir / "input.xlsx", index=False)

        # Copy groundtruth
        shutil.copy2(xlsx, out_dir / "groundtruth.xlsx")

        # Write config.json — merge with existing to preserve destination_lat/lon
        # and any other fields added by later phases (geocode, etc.)
        existing_config_path = out_dir / "config.json"
        config: dict = {}
        if existing_config_path.exists():
            try:
                config = json.loads(existing_config_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        # Override only the fields produced by extract; preserve everything else
        config["capacity"] = _get_capacity(xlsx)
        config["orario_fine_manifestazione"] = _get_fine_manifestazione(xlsx)
        if not config.get("destination") or config["destination"] == "Unknown":
            config["destination"] = get_event_destination(xlsx)
        (out_dir / "config.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        print(f"[extract] {name}: {len(df)} schools → {out_dir}")

    print(f"\nExtraction complete: {len(structured_files)} events.")


# -----------------------------------------------------------------------
# Phase 2 and 3 stubs (implemented in later tasks)
# -----------------------------------------------------------------------

def run_correct():
    """Phase 2: AI-correct addresses in each event's input.xlsx.

    Idempotent: skips events where input_corretto.xlsx already has AI_Corrected=True for all rows.
    Requires GOOGLE_API_KEY environment variable.
    """
    sys.path.insert(0, str(TESTS_DIR.parent))
    from address_corrector import AddressCorrector

    corrector = AddressCorrector()
    event_dirs = sorted(
        d for d in REALSUITE_DIR.iterdir()
        if d.is_dir() and (d / "input.xlsx").exists()
    )

    for ev_dir in event_dirs:
        input_path = ev_dir / "input.xlsx"
        corretto_path = ev_dir / "input_corretto.xlsx"

        # Skip if already fully corrected
        if corretto_path.exists():
            try:
                df_check = pd.read_excel(corretto_path)
                if "AI_Corrected" in df_check.columns and df_check["AI_Corrected"].astype(bool).all():
                    print(f"[correct] {ev_dir.name}: already corrected — skipping.")
                    continue
            except Exception:
                pass  # Re-correct if the file is unreadable

        df = pd.read_excel(input_path)
        schools = [
            {"name": str(row["Nome"]), "address": str(row["Indirizzo"])}
            for _, row in df.iterrows()
        ]

        _, status, unresolved = corrector.correct_addresses(
            schools, input_path, corretto_path
        )

        if unresolved:
            print(
                f"WARNING [{ev_dir.name}] {len(unresolved)} address(es) not resolved by AI:\n"
                + "\n".join(f"  - {u}" for u in unresolved)
            )

        print(f"[correct] {ev_dir.name}: status={status}")

    print("\nCorrection phase complete.")


def _haversine_m(lat1, lon1, lat2, lon2):
    """Return great-circle distance in metres between two (lat, lon) points."""
    R = 6_371_000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def run_geocode():
    """Phase 3: geocode schools + destination, sanity-check, write coords.json + time_matrix.json.

    Idempotent: skips events where both coords.json and time_matrix.json exist.
    Uses corrected addresses (input_corretto.xlsx) when available, else raw input.xlsx.
    """
    sys.path.insert(0, str(TESTS_DIR.parent))
    from geocoder import GeocodingService

    geo = GeocodingService()

    event_dirs = sorted(
        d for d in REALSUITE_DIR.iterdir()
        if d.is_dir() and (d / "input.xlsx").exists()
    )

    for ev_dir in event_dirs:
        coords_path = ev_dir / "coords.json"
        matrix_path = ev_dir / "time_matrix.json"

        if coords_path.exists() and matrix_path.exists():
            # Still patch destination_lat/lon into config if missing
            config_path = ev_dir / "config.json"
            if config_path.exists():
                config = json.loads(config_path.read_text(encoding="utf-8"))
                if "destination_lat" not in config and config.get("destination"):
                    dest_lat, dest_lon = geo.get_coordinates(config["destination"])
                    config["destination_lat"] = dest_lat
                    config["destination_lon"] = dest_lon
                    config_path.write_text(
                        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                    print(f"[geocode] {ev_dir.name}: patched destination lat/lon.")
                    continue
            print(f"[geocode] {ev_dir.name}: already done — skipping.")
            continue

        # Use corrected file if available, else raw input
        input_path = (
            ev_dir / "input_corretto.xlsx"
            if (ev_dir / "input_corretto.xlsx").exists()
            else ev_dir / "input.xlsx"
        )
        df = pd.read_excel(input_path)
        config = json.loads((ev_dir / "config.json").read_text(encoding="utf-8"))

        # Geocode destination
        dest_lat, dest_lon = geo.get_coordinates(config["destination"])
        config["destination_lat"] = dest_lat
        config["destination_lon"] = dest_lon
        (ev_dir / "config.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # Geocode schools
        schools = []
        for _, row in df.iterrows():
            name = str(row["Nome"])
            addr = str(row["Indirizzo"])
            lat, lon = geo.get_coordinates(addr)
            schools.append({"name": name, "lat": lat, "lon": lon})

        # Sanity check: flag any school >100 km from its nearest neighbor
        if len(schools) >= 2:
            for s in schools:
                min_dist = min(
                    _haversine_m(s["lat"], s["lon"], o["lat"], o["lon"])
                    for o in schools if o is not s
                )
                if min_dist > 100_000:
                    print(
                        f"WARNING [{ev_dir.name}] '{s['name']}' is >{min_dist/1000:.0f} km "
                        f"from all others — check address. Geocoded: ({s['lat']:.4f}, {s['lon']:.4f})"
                    )

        # Write coords.json
        coords_json = {s["name"]: {"lat": s["lat"], "lon": s["lon"]} for s in schools}
        coords_path.write_text(
            json.dumps(coords_json, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # Build time matrix: destination at index 0, schools at 1..N
        locations = [(dest_lat, dest_lon)] + [(s["lat"], s["lon"]) for s in schools]
        matrix = geo.get_time_matrix(locations)
        matrix_path.write_text(
            json.dumps(matrix, ensure_ascii=False), encoding="utf-8"
        )

        print(f"[geocode] {ev_dir.name}: {len(schools)} schools geocoded.")

    print("\nGeocoding phase complete.")


# -----------------------------------------------------------------------
# CLI entry point
# -----------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare realSuite test cases")
    parser.add_argument("--extract", action="store_true", help="Extract input.xlsx files")
    parser.add_argument("--correct", action="store_true", help="AI-correct addresses")
    parser.add_argument("--geocode", action="store_true", help="Geocode + build time matrices")
    args = parser.parse_args()

    run_all = not any([args.extract, args.correct, args.geocode])

    if args.extract or run_all:
        run_extract()
    if args.correct or run_all:
        run_correct()
    if args.geocode or run_all:
        run_geocode()
