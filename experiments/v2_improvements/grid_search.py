"""
Grid search over (max_detour_minutes, max_merge_minutes) for HumanStyleSolver.

Usage:
    python3 experiments/v2_improvements/grid_search.py

Output: table with 14 rows (V1 + V2-current baselines + 12 parameter combinations),
sorted by tot_km ascending.

Verdict criterion (from spec): choose the config that minimises tot_km without
losing more than 0.015 combined score vs V2-current.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make root modules importable regardless of cwd
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from evaluate_realSuite import (
    _all_events,
    load_event,
    load_groundtruth,
    solution_to_buses,
    combined_score,
    compute_route_metrics,
    run_v1,
    run_v2,
    _build_solver_matrix,
)
from optimizer_v2 import HumanStyleSolver


# -----------------------------------------------------------------------
# Config sweep
# -----------------------------------------------------------------------

DETOUR_VALUES = [20, 30, 40, 999_999]   # 999_999 ≈ ∞ (current V2 behaviour)
MERGE_VALUES  = [25, 35, 45]


def run_config(
    ev: dict,
    max_detour_minutes: int,
    max_merge_minutes: int,
) -> dict | None:
    """Run HumanStyleSolver with the given parameters on one event."""
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)
    demands = [0] + [s["demand"] for s in schools] + [0]

    solver = HumanStyleSolver(
        time_matrix=time_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        cluster_threshold_minutes=25,
        max_detour_minutes=max_detour_minutes,
        max_merge_minutes=max_merge_minutes,
    )
    return solver.solve()


def _progress(current: int, total: int, label: str = "", width: int = 30) -> None:
    filled = int(width * current / total) if total else 0
    bar = "#" * filled + "-" * (width - filled)
    print(f"\r[{bar}] {current}/{total}  {label:<40}", end="", flush=True)


# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------

def main() -> None:
    events = _all_events()
    loaded = []
    for d in events:
        ev = load_event(d)
        if ev is not None:
            loaded.append(ev)

    if not loaded:
        print("No events found. Run prepare_realSuite.py first.")
        return

    n_events = len(loaded)
    config_results = []

    # --- V1 baseline ---
    print("Running V1 baseline...")
    v1_combined = []
    v1_km = []
    v1_max = []
    for idx, ev in enumerate(loaded, 1):
        _progress(idx, n_events, ev["name"])
        sol = run_v1(ev)
        if sol:
            gt = load_groundtruth(ev["gt_path"])
            buses = solution_to_buses(sol, ev["schools"])
            v1_combined.append(combined_score(buses, gt))
            m = compute_route_metrics(sol, ev["schools"], ev["time_matrix"], ev.get("distance_matrix"))
            v1_km.append(m["total_km"])
            v1_max.append(m["max_route_min"])
    print()
    config_results.append({
        "label":    "V1 (OR-Tools)",
        "combined": sum(v1_combined) / len(v1_combined),
        "tot_km":   sum(v1_km),
        "max_min":  max(v1_max),
    })

    # --- V2 current baseline (detour=∞, merge=35) ---
    print("Running V2 current baseline...")
    v2_combined = []
    v2_km = []
    v2_max = []
    for idx, ev in enumerate(loaded, 1):
        _progress(idx, n_events, ev["name"])
        sol = run_v2(ev)
        if sol:
            gt = load_groundtruth(ev["gt_path"])
            buses = solution_to_buses(sol, ev["schools"])
            v2_combined.append(combined_score(buses, gt))
            m = compute_route_metrics(sol, ev["schools"], ev["time_matrix"], ev.get("distance_matrix"))
            v2_km.append(m["total_km"])
            v2_max.append(m["max_route_min"])
    print()
    v2_baseline_combined = sum(v2_combined) / len(v2_combined)
    config_results.append({
        "label":    "V2 (current)",
        "combined": v2_baseline_combined,
        "tot_km":   sum(v2_km),
        "max_min":  max(v2_max),
    })

    # --- 12 parameter combinations ---
    for max_detour in DETOUR_VALUES:
        for max_merge in MERGE_VALUES:
            detour_label = str(max_detour) if max_detour < 999_999 else "inf"
            label = f"d={detour_label:>3} / m={max_merge}"
            print(f"Running {label}...")
            comb_list = []
            km_list = []
            max_list = []
            for idx, ev in enumerate(loaded, 1):
                _progress(idx, n_events, ev["name"])
                sol = run_config(ev, max_detour, max_merge)
                if sol:
                    gt = load_groundtruth(ev["gt_path"])
                    buses = solution_to_buses(sol, ev["schools"])
                    comb_list.append(combined_score(buses, gt))
                    m = compute_route_metrics(
                        sol, ev["schools"], ev["time_matrix"], ev.get("distance_matrix")
                    )
                    km_list.append(m["total_km"])
                    max_list.append(m["max_route_min"])
            print()
            config_results.append({
                "label":    label,
                "combined": sum(comb_list) / len(comb_list) if comb_list else 0.0,
                "tot_km":   sum(km_list),
                "max_min":  max(max_list) if max_list else 0.0,
            })

    # --- Print table sorted by tot_km ---
    print()
    header_fmt = f"{'config':<22}  {'combined':>8}  {'tot_km':>8}  {'max_min':>7}  {'delta':>8}"
    sep = "-" * len(header_fmt)
    print(sep)
    print(header_fmt)
    print(sep)

    v2_tot_km = config_results[1]["tot_km"]
    sorted_results = sorted(config_results, key=lambda r: r["tot_km"])
    for r in sorted_results:
        delta = r["combined"] - v2_baseline_combined
        flag = " *" if (r["combined"] >= v2_baseline_combined - 0.015 and r["tot_km"] < v2_tot_km) else ""
        print(
            f"{r['label']:<22}  {r['combined']:>8.3f}  {r['tot_km']:>8.1f}  "
            f"{r['max_min']:>7.1f}  {delta:>+8.3f}{flag}"
        )
    print(sep)
    print()
    print(f"V2-current baseline: combined={v2_baseline_combined:.3f}, tot_km={v2_tot_km:.1f}")
    print("Rows marked * beat V2-current on tot_km with combined loss <= 0.015.")


if __name__ == "__main__":
    main()
