"""Utilities for the planner-vs-GT comparison tool."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment

AVERAGE_SPEED_KMH = 30.0   # must match app.py
STOP_DWELL_TIME_MIN = 3    # must match app.py


def load_groundtruth_full(gt_path: Path) -> dict:
    """
    Parse groundtruth.xlsx into rich per-bus data.

    Returns:
        {
          fin_id: {
            "stops": [{"name", "luogo_ritrovo", "departure_time", "return_time", "count"}],
            "distance_km": float | None
          }
        }
    Stops are ordered by their row position in the Excel (= route order).
    FIN # column may have blank cells below the first row of each bus group;
    ffill() fills them.
    """
    df = pd.read_excel(gt_path, sheet_name="Per Istituto")
    df.columns = [str(c).strip() for c in df.columns]
    df["FIN #"] = df["FIN #"].ffill()

    result: dict = {}
    for fin, group in df.groupby("FIN #", sort=False):
        fin_key = str(int(fin)) if not isinstance(fin, str) and not math.isnan(float(fin)) else str(fin)
        stops = []
        for _, row in group.iterrows():
            name = str(row.get("Istituto", "") or "").strip()
            if not name or name == "nan":
                continue
            stops.append({
                "name": name,
                "luogo_ritrovo": str(row.get("Luogo Ritrovo", "") or "").strip(),
                "departure_time": str(row.get("Orario Partenza", "") or "").strip(),
                "return_time": str(row.get("Rientro Presunto", "") or "").strip(),
                "count": int(row["Persone"]) if pd.notna(row.get("Persone")) else 0,
            })
        km_series = group["Km"].dropna() if "Km" in group.columns else pd.Series([], dtype=float)
        distance_km = float(km_series.iloc[0]) if not km_series.empty else None
        if stops:
            result[fin_key] = {"stops": stops, "distance_km": distance_km}
    return result


def resolve_coords(name: str, coords: dict) -> dict | None:
    """
    Match school name to coords dict (from coords.json).
    Returns {"lat": float, "lon": float} or None.
    Tries exact match first, then case-insensitive stripped match.
    """
    if name in coords:
        e = coords[name]
        return {"lat": e["lat"], "lon": e["lon"]}
    normalized = name.strip().lower()
    for key, e in coords.items():
        if key.strip().lower() == normalized:
            return {"lat": e["lat"], "lon": e["lon"]}
    return None


def enrich_gt_with_coords(gt_buses: dict, coords: dict) -> dict:
    """
    Add lat/lon to every GT stop by matching name against coords.json.
    Sets coords_missing=True for any stop without a match.
    Does not mutate gt_buses.
    """
    result = {}
    for fin, bus in gt_buses.items():
        enriched = []
        for stop in bus["stops"]:
            c = resolve_coords(stop["name"], coords)
            enriched.append({
                **stop,
                "lat": c["lat"] if c else None,
                "lon": c["lon"] if c else None,
                "coords_missing": c is None,
            })
        result[fin] = {**bus, "stops": enriched}
    return result
