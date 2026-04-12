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
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from evaluate_realSuite import (
    combined_score,
    load_event,
    load_groundtruth,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from tools.compare_lib import (
    derive_arrival_time,
    enrich_gt_with_coords,
    format_planner_routes,
    load_groundtruth_full,
    match_buses,
)

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


def process_event(ev_dir: Path) -> dict | None:
    """
    Run V2 planner on one event, compute comparison data.
    Returns None if fixture is incomplete or solver fails.
    """
    ev = load_event(ev_dir)
    if ev is None:
        return None

    coords = _load_coords(ev_dir)
    config = _load_config(ev_dir)

    # --- Ground truth ---
    gt_simple = load_groundtruth(ev["gt_path"])   # {fin: set(names)} for scoring
    gt_full = load_groundtruth_full(ev["gt_path"]) # {fin: {stops, distance_km}}
    gt_full = enrich_gt_with_coords(gt_full, coords)

    # --- Run V2 planner ---
    solution = run_v2(ev)
    if solution is None:
        print(f"  [warn] solver returned None for {ev_dir.name}")
        return None

    # --- Scores ---
    pred_buses = solution_to_buses(solution, ev["schools"])  # {bus_id: set(names)}
    asgn  = score_assignment(pred_buses, gt_simple)
    cnt   = score_bus_count(pred_buses, gt_simple)
    comb  = combined_score(pred_buses, gt_simple)

    # --- Format planner routes with departure times ---
    arrival_time = derive_arrival_time(gt_full, ev["schools"], ev["time_matrix"])
    planner_routes = format_planner_routes(
        solution, ev["schools"], ev["time_matrix"], coords, arrival_time
    )

    # --- Match planner buses to GT buses ---
    pairs, unmatched_p, unmatched_gt = match_buses(pred_buses, gt_simple)

    # Build planner + GT dicts keyed by id for easy lookup
    planner_by_id = {str(r["vehicle_id"]): r for r in planner_routes}
    gt_by_fin = gt_full  # already keyed by fin_id

    matched_pairs = []
    for pair in pairs:
        p_route = planner_by_id.get(pair["p_id"])
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
        {**gt_by_fin[gid], "fin": gid} for gid in unmatched_gt if gid in gt_by_fin
    ]

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
        "scores": {
            "assignment": round(asgn, 4),
            "bus_count": round(cnt, 4),
            "combined": round(comb, 4),
        },
        "destination": destination,
        "matched_pairs": matched_pairs,
        "unmatched_planner": unmatched_planner_list,
        "unmatched_gt": unmatched_gt_list,
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

        index.append({
            "slug": slug,
            "name": ev_dir.name,
            "destination": data["event"]["destination"],
            "scores": data["scores"],
        })
        print(f"done → {out_path.name}  (combined={data['scores']['combined']:.3f})")

    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n✓ {len(index)} events written to {OUT_DIR}")


if __name__ == "__main__":
    main()
