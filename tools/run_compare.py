#!/usr/bin/env python3
"""
Pre-compute planner-vs-GT comparison data for all complete realSuite fixtures.

Usage:
    python3 tools/run_compare.py

Writes:
    tools/compare/data/index.json         — event list with summary scores
    tools/compare/data/<slug>.json        — per-event comparison data
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from evaluate_realSuite import (
    _build_solver_matrix,
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from tools.compare_lib import (
    compute_gt_route_distances,
    derive_arrival_time,
    enrich_gt_with_coords,
    format_planner_routes,
    load_groundtruth_full,
    match_buses,
)
from experiments.v1_improved.optimizer_v1_improved import ImprovedVRPSolver

REALSUITE_DIR = ROOT / "tests" / "realSuite"
OUT_DIR = ROOT / "tools" / "compare" / "data"


def _slug(name: str) -> str:
    """Convert event directory name to a URL-safe slug."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]


def _load_coords(ev_dir: Path) -> dict:
    coords_path = ev_dir / "coords.json"
    if not coords_path.exists():
        return {}
    return json.loads(coords_path.read_text(encoding="utf-8"))


def _load_config(ev_dir: Path) -> dict:
    config_path = ev_dir / "config.json"
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return int(R * 2 * math.asin(math.sqrt(a)))


def _load_distance_matrix(
    ev_dir: Path, schools: list[dict], coords: dict, config: dict
) -> list[list[int]] | None:
    """Load distance_matrix.json if present; fall back to haversine."""
    p = ev_dir / "distance_matrix.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    dest_lat = config.get("destination_lat")
    dest_lon = config.get("destination_lon")
    if dest_lat is None or dest_lon is None:
        return None
    locations: list[tuple[float, float]] = [(dest_lat, dest_lon)]
    for s in schools:
        c = coords.get(s["name"])
        if c is None:
            return None
        locations.append((c["lat"], c["lon"]))
    n = len(schools)
    matrix: list[list[int]] = []
    for i in range(n + 1):
        row = []
        for j in range(n + 1):
            if i == j:
                row.append(0)
            else:
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                row.append(_haversine_m(lat1, lon1, lat2, lon2))
        matrix.append(row)
    return matrix


def _run_v1_improved(ev: dict, dist_matrix_full: list[list[int]]) -> dict | None:
    """Run ImprovedVRPSolver on one event using spec defaults."""
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    arrival_time_str = ev.get("arrival_time", "12:00")

    time_matrix = _build_solver_matrix(ev["time_matrix"], n)
    dm_ext = [row[:] + [0] for row in dist_matrix_full]
    dm_ext.append([0] * (n + 2))

    demands = [0] + [s["demand"] for s in schools] + [0]
    total = sum(s["demand"] for s in schools)
    num_vehicles = math.ceil(total / capacity) + 3
    dummy_idx = n + 1

    solver = ImprovedVRPSolver(fixed_vehicle_cost=600, time_limit_seconds=30)
    return solver.solve(
        time_matrix=time_matrix,
        distance_matrix=dm_ext,
        demands=demands,
        num_vehicles=num_vehicles,
        starts=[dummy_idx] * num_vehicles,
        ends=[0] * num_vehicles,
        arrival_time_str=arrival_time_str,
        bus_capacity=capacity,
    )


def _run_solver_plan(
    key: str,
    ev: dict,
    ev_dir: Path,
    coords: dict,
    gt_simple: dict,
    gt_full: dict,
    arrival_time: str,
    dist_matrix_full: list[list[int]] | None,
    distance_matrix_for_fmt: list[list[int]] | None,
) -> dict | None:
    """Run one solver; return {matched_pairs, unmatched_planner, unmatched_gt, scores} or None."""
    if key == "v2":
        solution = run_v2(ev)
    elif key == "v1":
        solution = run_v1(ev)
    elif key == "v1improved":
        if dist_matrix_full is None:
            print(f"  [warn] v1improved skipped for {ev_dir.name}: no distance matrix")
            return None
        solution = _run_v1_improved(ev, dist_matrix_full)
    else:
        return None

    if solution is None:
        print(f"  [warn] {key} solver returned None for {ev_dir.name}")
        return None

    pred_buses = solution_to_buses(solution, ev["schools"])
    asgn = score_assignment(pred_buses, gt_simple)
    cnt  = score_bus_count(pred_buses, gt_simple)
    comb = combined_score(pred_buses, gt_simple)

    planner_routes = format_planner_routes(
        solution, ev["schools"], ev["time_matrix"], coords, arrival_time, distance_matrix_for_fmt
    )
    pairs, unmatched_p, unmatched_gt_ids = match_buses(pred_buses, gt_simple)
    planner_by_id = {str(r["vehicle_id"]): r for r in planner_routes}
    gt_by_fin = gt_full

    matched_pairs = []
    for pair in pairs:
        p_route = planner_by_id.get(pair["p_id"])
        if p_route is None:
            print(f"  [warn] planner route for vehicle {pair['p_id']} not found in formatted routes")
        g_bus = gt_by_fin.get(pair["gt_id"])
        matched_pairs.append({
            "jaccard": pair["jaccard"],
            "planner": p_route or {"vehicle_id": pair["p_id"], "stops": [], "distance_km": 0},
            "gt": g_bus or {"stops": [], "distance_km": None},
            "gt_fin": pair["gt_id"],
        })

    unmatched_planner_list = [
        planner_by_id[pid] for pid in unmatched_p if pid in planner_by_id
    ]
    unmatched_gt_list = [
        {**gt_by_fin[gid], "fin": gid} for gid in unmatched_gt_ids if gid in gt_by_fin
    ]

    return {
        "matched_pairs": matched_pairs,
        "unmatched_planner": unmatched_planner_list,
        "unmatched_gt": unmatched_gt_list,
        "scores": {
            "assignment": round(asgn, 4),
            "bus_count": round(cnt, 4),
            "combined": round(comb, 4),
        },
    }


def process_event(ev_dir: Path) -> dict | None:
    """Run all 3 solvers on one event; return comparison data with planners dict."""
    ev = load_event(ev_dir)
    if ev is None:
        return None

    coords = _load_coords(ev_dir)
    config = _load_config(ev_dir)

    # GT data (shared across solvers)
    _gt_raw = load_groundtruth(ev["gt_path"])
    gt_simple: dict = {}
    for k, v in _gt_raw.items():
        try:
            gt_simple[str(int(float(k)))] = v
        except (ValueError, TypeError):
            gt_simple[k] = v
    gt_full = load_groundtruth_full(ev["gt_path"])
    gt_full = enrich_gt_with_coords(gt_full, coords)

    # Verify GT key sets are consistent before passing to solvers
    if set(gt_simple.keys()) != set(gt_full.keys()):
        print(f"  [warn] GT key mismatch for {ev_dir.name}: simple={set(gt_simple.keys())} full={set(gt_full.keys())}")

    # Distance matrices
    dist_matrix_path = ev_dir / "distance_matrix.json"
    distance_matrix_for_fmt = (
        json.loads(dist_matrix_path.read_text(encoding="utf-8"))
        if dist_matrix_path.exists()
        else None
    )
    dist_matrix_full = _load_distance_matrix(ev_dir, ev["schools"], coords, config)
    if distance_matrix_for_fmt is not None:
        gt_full = compute_gt_route_distances(gt_full, ev["schools"], distance_matrix_for_fmt)

    # Arrival time
    if config.get("arrival_time"):
        arrival_time = config["arrival_time"]
    else:
        arrival_time = derive_arrival_time(gt_full, ev["schools"], ev["time_matrix"])
        config_path = ev_dir / "config.json"
        config["arrival_time"] = arrival_time
        config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # Inject arrival_time into ev so _run_v1_improved can read it
    ev_with_time = {**ev, "arrival_time": arrival_time}

    # Run all solvers
    planners: dict = {}
    for key in ("v2", "v1", "v1improved"):
        result = _run_solver_plan(
            key=key,
            ev=ev_with_time,
            ev_dir=ev_dir,
            coords=coords,
            gt_simple=gt_simple,
            gt_full=gt_full,
            arrival_time=arrival_time,
            dist_matrix_full=dist_matrix_full,
            distance_matrix_for_fmt=distance_matrix_for_fmt,
        )
        if result is not None:
            planners[key] = result

    if not planners:
        print(f"  [warn] all solvers failed for {ev_dir.name}")
        return None

    destination = {
        "name": config.get("destination", ""),
        "lat": config.get("destination_lat"),
        "lon": config.get("destination_lon"),
    }

    return {
        "event": {
            "name": ev_dir.name,
            "destination": config.get("destination", ""),
            "capacity": ev["capacity"],
        },
        "arrival_time": arrival_time,
        "destination": destination,
        "planners": planners,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    events = sorted(d for d in REALSUITE_DIR.iterdir() if d.is_dir())
    index = []

    for ev_dir in events:
        print(f"Processing {ev_dir.name}...", end=" ", flush=True)
        data = process_event(ev_dir)
        if data is None:
            print("skipped")
            continue

        slug = _slug(ev_dir.name)
        out_path = OUT_DIR / f"{slug}.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        index_scores = {key: p["scores"] for key, p in data["planners"].items()}
        v2_combined = data["planners"].get("v2", {}).get("scores", {}).get("combined", 0.0)

        index.append({
            "slug": slug,
            "name": ev_dir.name,
            "destination": data["event"]["destination"],
            "scores": index_scores,
        })
        print(f"done → {out_path.name}  (v2 combined={v2_combined:.3f})")

    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n✓ {len(index)} events written to {OUT_DIR}")


if __name__ == "__main__":
    main()
