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


def _jaccard(a: set, b: set) -> float:
    """Compute Jaccard similarity between two sets."""
    union = a | b
    return len(a & b) / len(union) if union else 1.0


def match_buses(planner_buses: dict, gt_buses: dict) -> tuple[list[dict], list, list]:
    """
    Match planner buses to GT buses maximising Jaccard similarity.

    Args:
        planner_buses: {bus_id: set(school_names)}
        gt_buses:      {fin_id: set(school_names)}

    Returns:
        (pairs, unmatched_planner, unmatched_gt)
        pairs: [{"p_id": str, "gt_id": str, "jaccard": float}] descending Jaccard
        unmatched_planner: [bus_id, ...] — excess planner buses
        unmatched_gt:      [fin_id, ...]  — excess GT buses
    """
    p_ids = list(planner_buses.keys())
    g_ids = list(gt_buses.keys())
    if not p_ids or not g_ids:
        return [], p_ids[:], g_ids[:]

    n, m = len(p_ids), len(g_ids)
    cost = np.zeros((n, m))
    for i, pid in enumerate(p_ids):
        for j, gid in enumerate(g_ids):
            cost[i, j] = -_jaccard(planner_buses[pid], gt_buses[gid])

    row_ind, col_ind = linear_sum_assignment(cost)
    paired_p, paired_g = set(), set()
    pairs = []
    for r, c in zip(row_ind, col_ind):
        pairs.append({
            "p_id": p_ids[r],
            "gt_id": g_ids[c],
            "jaccard": round(float(-cost[r, c]), 4),
        })
        paired_p.add(p_ids[r])
        paired_g.add(g_ids[c])

    pairs.sort(key=lambda x: x["jaccard"], reverse=True)
    return (
        pairs,
        [p for p in p_ids if p not in paired_p],
        [g for g in g_ids if g not in paired_g],
    )


def _parse_time(t: str) -> int | None:
    """Parse HH:MM to total minutes. Returns None if unparseable or not exactly HH:MM."""
    try:
        parts = str(t).strip().split(":")
        if len(parts) != 2:
            return None
        h, m = parts
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _fmt_time(total_minutes: int) -> str:
    """Format total minutes to HH:MM."""
    h = int(total_minutes) // 60
    m = int(total_minutes) % 60
    return f"{h:02d}:{m:02d}"


def derive_arrival_time(gt_buses: dict, schools: list, time_matrix: list) -> str:
    """
    Estimate target arrival time at destination from GT departure times.

    For each GT bus, takes the last stop's departure_time and adds the
    travel time from that school to the destination (node 0) using time_matrix.
    Returns the median of all estimates as HH:MM. Falls back to "09:00".

    Args:
        gt_buses:    output of load_groundtruth_full (stops have departure_time strings)
        schools:     [{"name": str, ...}] in the same order as time_matrix nodes 1..N
        time_matrix: raw (N+1)×(N+1) matrix (index 0=dest, 1..N=schools)
    """
    school_index = {s["name"]: i + 1 for i, s in enumerate(schools)}
    arrivals = []
    for fin, bus in gt_buses.items():
        valid = [s for s in bus["stops"] if _parse_time(s.get("departure_time", "")) is not None]
        if not valid:
            continue
        last = valid[-1]
        node = school_index.get(last["name"])
        if node is None or node >= len(time_matrix):
            continue
        dep_min = _parse_time(last["departure_time"])
        if dep_min is None:
            continue
        travel_min = time_matrix[node][0] // 60
        arrivals.append(dep_min + travel_min)

    if not arrivals:
        return "09:00"
    return _fmt_time(sorted(arrivals)[len(arrivals) // 2])


def compute_gt_route_distances(
    gt_buses: dict,
    schools: list,
    distance_matrix: list[list[int]],
) -> dict:
    """
    Compute distance_km for each GT bus route using the distance matrix.

    Args:
        gt_buses:        {fin_id: {"stops": [...], ...}} from load_groundtruth_full
        schools:         [{"name": str, "demand": int}] — same order as distance_matrix nodes 1..N
        distance_matrix: (N+1)×(N+1) in metres (index 0=dest, 1..N=schools)

    Returns:
        Updated gt_buses dict with distance_km populated for each bus.
    """
    name_to_idx = {s["name"]: i + 1 for i, s in enumerate(schools)}
    result = {}
    for fin_id, bus in gt_buses.items():
        stops = bus.get("stops", [])
        stop_names = [s["name"] for s in stops if isinstance(s, dict)]
        total_m = 0
        for k, name in enumerate(stop_names):
            idx = name_to_idx.get(name)
            if idx is None:
                continue
            next_name = stop_names[k + 1] if k + 1 < len(stop_names) else None
            next_idx = name_to_idx.get(next_name) if next_name else 0
            if next_idx is not None:
                total_m += distance_matrix[idx][next_idx]
        distance_km = round(total_m / 1000, 2) if total_m else bus.get("distance_km")
        result[fin_id] = {**bus, "distance_km": distance_km}
    return result


def format_planner_routes(
    solution: dict,
    schools: list,
    time_matrix: list,
    coords: dict,
    arrival_time: str,
    distance_matrix: list[list[int]] | None = None,
) -> list:
    """
    Convert raw VRP solution to UI-ready route list.

    Departure times are back-calculated from arrival_time at destination:
        dep(stop_i) = arrival_time
                    - Σ travel(stop_k → stop_{k+1}) for k=i..last
                    - (n_stops_after_i) × STOP_DWELL_TIME_MIN

    Args:
        solution:     VRPSolver / HumanStyleSolver .solve() output
        schools:      [{"name": str, "demand": int}] — same order as time_matrix nodes 1..N
        time_matrix:  raw (N+1)×(N+1) (index 0=dest, 1..N=schools)
        coords:       {school_name: {"lat": float, "lon": float}}
        arrival_time: "HH:MM" when all buses arrive at destination

    Returns:
        [{"vehicle_id": int, "stops": [...], "distance_km": float}]
        Each stop: {"name", "lat", "lon", "departure_time", "count"}
    """
    arrival_min = _parse_time(arrival_time) or 0
    n = len(schools)
    routes = []

    for route in solution["routes"]:
        # Collect school nodes (exclude dest=0 and dummy=n+1)
        school_nodes = [s["node"] for s in route["stops"] if 1 <= s["node"] <= n]
        if not school_nodes:
            continue

        # Back-calculate departure times from arrival_time.
        # STOP_DWELL_TIME_MIN is subtracted at every stop (including the first),
        # consistent with app.py's back-calculation logic.
        cum = arrival_min
        stop_times: list = []
        for k in range(len(school_nodes) - 1, -1, -1):
            node = school_nodes[k]
            next_node = school_nodes[k + 1] if k + 1 < len(school_nodes) else 0
            travel_min = time_matrix[node][next_node] // 60
            cum -= travel_min + STOP_DWELL_TIME_MIN
            stop_times.insert(0, cum)

        # Build stop list + compute total km.
        # Prefer distance_matrix (metres) when available; fall back to time-matrix estimate.
        # Dummy-start → first-school leg is excluded (dummy node is zero-cost).
        total_km = 0.0
        stop_list = []
        for k, node in enumerate(school_nodes):
            school = schools[node - 1]
            c = resolve_coords(school["name"], coords)
            next_node = school_nodes[k + 1] if k + 1 < len(school_nodes) else 0
            if distance_matrix is not None:
                seg_km = round(distance_matrix[node][next_node] / 1000, 2)
            else:
                seg_s = time_matrix[node][next_node]
                seg_km = round(seg_s / 3600 * AVERAGE_SPEED_KMH, 2)
            total_km += seg_km
            stop_list.append({
                "name": school["name"],
                "lat": c["lat"] if c else None,
                "lon": c["lon"] if c else None,
                "departure_time": _fmt_time(stop_times[k]),
                "count": school["demand"],
            })

        routes.append({
            "vehicle_id": route["vehicle_id"],
            "stops": stop_list,
            "distance_km": round(total_km, 2),
        })
    return routes
