"""
Evaluation script for realSuite test cases.

Standalone usage:
  python tests/evaluate_realSuite.py

Shared scoring functions are imported by tests/test_realSuite.py.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
sys.path.insert(0, str(TESTS_DIR.parent))  # make root modules importable

# -----------------------------------------------------------------------
# Scoring functions
# -----------------------------------------------------------------------

def score_assignment(pred_buses: dict, gt_buses: dict) -> float:
    """
    Hungarian-algorithm matched mean Jaccard similarity.

    pred_buses: {bus_id: set(school_names)}
    gt_buses:   {fin_id: set(school_names)}
    Returns float in [0, 1].
    """
    pred_list = [v for v in pred_buses.values() if v]
    gt_list   = [v for v in gt_buses.values()   if v]

    if not pred_list or not gt_list:
        return 0.0

    size = max(len(pred_list), len(gt_list))
    cost = np.zeros((size, size))

    for i, p in enumerate(pred_list):
        for j, g in enumerate(gt_list):
            inter = len(p & g)
            union = len(p | g)
            cost[i, j] = -(inter / union) if union > 0 else 0.0

    row_ind, col_ind = linear_sum_assignment(cost)
    n_pred_real = len(pred_list)
    n_gt_real   = len(gt_list)
    # Keep only assignments between real (non-padded) pred and gt rows/cols
    real_mask = (row_ind < n_pred_real) & (col_ind < n_gt_real)
    real_scores = -cost[row_ind[real_mask], col_ind[real_mask]]
    if real_scores.size == 0:
        return 0.0
    return float(real_scores.mean())


def score_bus_count(pred_buses: dict, gt_buses: dict) -> float:
    """1 − |pred − gt| / gt, clipped to [0, 1]. Counts only non-empty buses."""
    n_pred = len([v for v in pred_buses.values() if v])
    n_gt   = len([v for v in gt_buses.values()   if v])
    if n_gt == 0:
        return 1.0 if n_pred == 0 else 0.0
    return max(0.0, 1.0 - abs(n_pred - n_gt) / n_gt)


def combined_score(pred_buses: dict, gt_buses: dict) -> float:
    """0.6 × assignment_score + 0.4 × bus_count_score."""
    return 0.6 * score_assignment(pred_buses, gt_buses) + 0.4 * score_bus_count(pred_buses, gt_buses)


# -----------------------------------------------------------------------
# Data loaders
# -----------------------------------------------------------------------

def load_event(ev_dir: Path) -> dict | None:
    """
    Load all artifacts for one event.
    Returns None if required files are missing (prints a notice).
    """
    input_path = ev_dir / "input_corretto.xlsx"
    if not input_path.exists():
        input_path = ev_dir / "input.xlsx"
    matrix_path = ev_dir / "time_matrix.json"
    config_path = ev_dir / "config.json"
    gt_path     = ev_dir / "groundtruth.xlsx"

    for p in [input_path, matrix_path, config_path, gt_path]:
        if not p.exists():
            print(f"[skip] {ev_dir.name}: missing {p.name}")
            return None

    df = pd.read_excel(input_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    time_matrix = json.loads(matrix_path.read_text(encoding="utf-8"))

    schools = [
        {"name": str(row["Nome"]), "demand": int(row["Partecipanti"])}
        for _, row in df.iterrows()
    ]

    return {
        "name": ev_dir.name,
        "schools": schools,
        "time_matrix": time_matrix,
        "capacity": config.get("capacity", 54),
        "gt_path": gt_path,
    }


def load_groundtruth(gt_path: Path) -> dict:
    """Returns {fin_id: set(school_names)} from the 'Per Istituto' sheet."""
    df = pd.read_excel(gt_path, sheet_name="Per Istituto")
    df.columns = [c.strip() for c in df.columns]
    result: dict = {}
    for _, row in df.iterrows():
        fin = str(row.get("FIN #", "")).strip()
        school = str(row.get("Istituto", "")).strip()
        if fin and school and school != "nan":
            result.setdefault(fin, set()).add(school)
    return result


def solution_to_buses(solution: dict, schools: list) -> dict:
    """Map VRPSolver/HumanStyleSolver output → {bus_id: set(school_names)}."""
    result: dict = {}
    for route in solution["routes"]:
        bus_id = str(route["vehicle_id"])
        names: set = set()
        for stop in route["stops"]:
            node = stop["node"]
            if 1 <= node <= len(schools):
                names.add(schools[node - 1]["name"])
        if names:
            result[bus_id] = names
    return result


# -----------------------------------------------------------------------
# V1 runner
# -----------------------------------------------------------------------

def _build_solver_matrix(time_matrix: list, n_schools: int) -> list:
    """Extend the (N+1)×(N+1) matrix with a dummy start row/col (all zeros)."""
    real = [row[:] + [0] for row in time_matrix]
    real.append([0] * (n_schools + 2))
    return real


def run_v1(ev: dict) -> dict | None:
    """Run VRPSolver (V1) on an event dict. Returns solution or None."""
    from optimizer import VRPSolver

    schools = ev["schools"]
    n = len(schools)
    dummy_idx = n + 1
    capacity = ev["capacity"]
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)

    demands = [0] + [s["demand"] for s in schools] + [0]
    total = sum(s["demand"] for s in schools)
    num_vehicles = math.ceil(total / capacity) + 3

    solver = VRPSolver(
        time_matrix=time_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        num_vehicles=num_vehicles,
        depot_index=0,
        fixed_vehicle_cost=3600,
        starts=[dummy_idx] * num_vehicles,
        ends=[0] * num_vehicles,
    )
    return solver.solve()


def run_v2(ev: dict, cluster_threshold_minutes: int = 20) -> dict | None:
    """Run HumanStyleSolver (V2) on an event dict. Returns solution or None."""
    from optimizer_v2 import HumanStyleSolver

    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)

    demands = [0] + [s["demand"] for s in schools] + [0]

    solver = HumanStyleSolver(
        time_matrix=time_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        cluster_threshold_minutes=cluster_threshold_minutes,
    )
    return solver.solve()


# -----------------------------------------------------------------------
# Standalone runner (table output)
# -----------------------------------------------------------------------

def _all_events() -> list:
    return sorted(
        d for d in REALSUITE_DIR.iterdir()
        if d.is_dir() and (d / "input.xlsx").exists()
    )


def main():
    events = _all_events()
    rows = []

    for ev_dir in events:
        ev = load_event(ev_dir)
        if ev is None:
            continue

        gt = load_groundtruth(ev["gt_path"])
        gt_count = len(gt)

        # V1
        sol_v1 = run_v1(ev)
        if sol_v1:
            pred_v1 = solution_to_buses(sol_v1, ev["schools"])
            s_v1 = combined_score(pred_v1, gt)
            n_v1 = len(pred_v1)
        else:
            s_v1, n_v1 = 0.0, 0

        # V2
        sol_v2 = run_v2(ev)
        if sol_v2:
            pred_v2 = solution_to_buses(sol_v2, ev["schools"])
            s_v2 = combined_score(pred_v2, gt)
            n_v2 = len(pred_v2)
        else:
            s_v2, n_v2 = 0.0, 0

        rows.append({
            "Event": ev["name"][:45],
            "GT buses": gt_count,
            "V1 buses": n_v1,
            "V1 score": f"{s_v1:.3f}",
            "V2 buses": n_v2,
            "V2 score": f"{s_v2:.3f}",
        })

    if not rows:
        print("No events with complete artifacts found. Run prepare_realSuite.py first.")
        return

    # Table header
    col_w = [46, 9, 9, 9, 9, 9]
    cols  = ["Event", "GT buses", "V1 buses", "V1 score", "V2 buses", "V2 score"]
    header = "  ".join(c.ljust(w) for c, w in zip(cols, col_w))
    sep    = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, col_w)))
    print(sep)

    v1_scores = [float(r["V1 score"]) for r in rows if r["V1 score"] != "—"]
    if v1_scores:
        print(f"\nMean V1: {sum(v1_scores)/len(v1_scores):.3f}")
    v2_scores = [float(r["V2 score"]) for r in rows if r["V2 score"] != "—"]
    if v2_scores:
        print(f"Mean V2: {sum(v2_scores)/len(v2_scores):.3f}")


if __name__ == "__main__":
    main()
