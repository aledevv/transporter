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


def run_v2(ev: dict, cluster_threshold_minutes: int = 10) -> dict | None:
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
# Return-time helpers
# -----------------------------------------------------------------------

def load_return_groundtruth(gt_path: Path) -> dict:
    """
    Returns {school_name: rientro_presunto_minutes} from the 'Per Istituto' sheet.
    Only includes rows where Rientro Presunto is a valid HH:MM string.
    """
    df = pd.read_excel(gt_path, sheet_name="Per Istituto")
    df.columns = [c.strip() for c in df.columns]
    result = {}
    for _, row in df.iterrows():
        school = str(row.get("Istituto", "")).strip()
        rientro = str(row.get("Rientro Presunto", "")).strip()
        if not school or school == "nan" or not rientro or rientro == "nan":
            continue
        if ":" in rientro:
            try:
                h, m = map(int, rientro[:5].split(":"))
                result[school] = h * 60 + m
            except ValueError:
                pass
    return result


def score_return_times(solution: dict, schools: list, gt_return: dict, tolerance_min: int = 30) -> float:
    """
    Fraction of stops whose calculated return_time is within tolerance_min of groundtruth.
    Returns float in [0, 1]. Returns None if no groundtruth data available.
    """
    if not gt_return:
        return None

    hits = 0
    total = 0
    for route in solution["routes"]:
        for stop in route["stops"]:
            node = stop["node"]
            if not (1 <= node <= len(schools)):
                continue
            school_name = schools[node - 1]["name"]
            if school_name not in gt_return:
                continue
            total += 1
            return_time_str = stop.get("return_time")
            if not return_time_str:
                continue
            try:
                h, m = map(int, return_time_str[:5].split(":"))
                pred_min = h * 60 + m
                gt_min = gt_return[school_name]
                if abs(pred_min - gt_min) <= tolerance_min:
                    hits += 1
            except ValueError:
                pass

    return hits / total if total > 0 else None


# -----------------------------------------------------------------------
# Standalone runner (table output)
# -----------------------------------------------------------------------

def _all_events() -> list:
    return sorted(
        d for d in REALSUITE_DIR.iterdir()
        if d.is_dir() and (d / "input.xlsx").exists()
    )


def _progress(current: int, total: int, label: str = "", width: int = 30) -> None:
    filled = int(width * current / total) if total else 0
    bar = "#" * filled + "-" * (width - filled)
    print(f"\r[{bar}] {current}/{total}  {label:<45}", end="", flush=True)


def main():
    events = _all_events()
    total = len(events)
    rows = []

    for idx, ev_dir in enumerate(events, 1):
        _progress(idx, total, ev_dir.name)
        ev = load_event(ev_dir)
        if ev is None:
            continue

        gt = load_groundtruth(ev["gt_path"])
        gt_count = len([v for v in gt.values() if v])

        # V1
        sol_v1 = run_v1(ev)
        if sol_v1:
            pred_v1 = solution_to_buses(sol_v1, ev["schools"])
            n_v1    = len(pred_v1)
            v1_asgn = score_assignment(pred_v1, gt)
            v1_cnt  = score_bus_count(pred_v1, gt)
            v1_tot  = 0.6 * v1_asgn + 0.4 * v1_cnt
        else:
            n_v1 = 0
            v1_asgn = v1_cnt = v1_tot = 0.0

        # V2
        sol_v2 = run_v2(ev)
        if sol_v2:
            pred_v2 = solution_to_buses(sol_v2, ev["schools"])
            n_v2    = len(pred_v2)
            v2_asgn = score_assignment(pred_v2, gt)
            v2_cnt  = score_bus_count(pred_v2, gt)
            v2_tot  = 0.6 * v2_asgn + 0.4 * v2_cnt
        else:
            n_v2 = 0
            v2_asgn = v2_cnt = v2_tot = 0.0

        rows.append({
            "Event":   ev["name"][:45],
            "GT":      gt_count,
            "V1_n":    n_v1,
            "V1_asgn": f"{v1_asgn:.3f}",
            "V1_cnt":  f"{v1_cnt:.3f}",
            "V1_tot":  f"{v1_tot:.3f}",
            "V2_n":    n_v2,
            "V2_asgn": f"{v2_asgn:.3f}",
            "V2_cnt":  f"{v2_cnt:.3f}",
            "V2_tot":  f"{v2_tot:.3f}",
        })

    print()  # newline after progress bar

    if not rows:
        print("No events with complete artifacts found. Run prepare_realSuite.py first.")
        return

    cols  = ["Event", "GT", "V1_n", "V1_asgn", "V1_cnt", "V1_tot", "V2_n", "V2_asgn", "V2_cnt", "V2_tot"]
    col_w = [46,       4,    5,      8,          8,         8,        5,      8,          8,         8]
    header = "  ".join(c.ljust(w) for c, w in zip(cols, col_w))
    sep    = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, col_w)))
    print(sep)

    numeric_cols = ["GT", "V1_n", "V1_asgn", "V1_cnt", "V1_tot", "V2_n", "V2_asgn", "V2_cnt", "V2_tot"]
    mean_row = {"Event": "MEAN"}
    for col in numeric_cols:
        vals = [float(r[col]) for r in rows]
        mean_row[col] = f"{sum(vals)/len(vals):.3f}"
    print("  ".join(str(mean_row.get(c, "")).ljust(w) for c, w in zip(cols, col_w)))


if __name__ == "__main__":
    main()
