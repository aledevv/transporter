"""
Three-way comparison: V1 (VRPSolver) / V2 (HumanStyleSolver) / V3 (SavingsSolver).

Usage (from project root):
  python experiments/savings_solver/evaluate_savings.py

Uses pre-computed time_matrix.json — no OSRM or LLM calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Path setup: root first (for optimizer*.py), then tests/ (for evaluate_realSuite)
_HERE = Path(__file__).parent
_ROOT = _HERE.parent.parent
_TESTS = _ROOT / "tests"
sys.path.insert(0, str(_HERE))   # optimizer_savings
sys.path.insert(0, str(_ROOT))   # optimizer, optimizer_v2
sys.path.insert(0, str(_TESTS))  # evaluate_realSuite

from evaluate_realSuite import (
    _all_events,
    _build_solver_matrix,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from optimizer_savings import SavingsSolver


def run_savings(ev: dict, min_savings_minutes: int = 0) -> dict | None:
    """Run SavingsSolver on an event dict. Returns solution or None."""
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)
    demands = [0] + [s["demand"] for s in schools] + [0]

    solver = SavingsSolver(
        time_matrix=time_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        min_savings_minutes=min_savings_minutes,
    )
    return solver.solve()


def main():
    events = _all_events()
    total = len(events)
    rows = []

    for idx, ev_dir in enumerate(events, 1):
        print(f"\r[{idx}/{total}] {ev_dir.name[:50]:<50}", end="", flush=True)
        ev = load_event(ev_dir)
        if ev is None:
            continue

        gt = load_groundtruth(ev["gt_path"])
        gt_count = len([v for v in gt.values() if v])

        def _score(sol, _ev=ev, _gt=gt):
            if not sol:
                return 0, 0.0, 0.0, 0.0
            pred = solution_to_buses(sol, _ev["schools"])
            a = score_assignment(pred, _gt)
            c = score_bus_count(pred, _gt)
            return len(pred), a, c, 0.6 * a + 0.4 * c

        n_v1, v1_a, v1_c, v1_t = _score(run_v1(ev))
        n_v2, v2_a, v2_c, v2_t = _score(run_v2(ev))
        n_v3, v3_a, v3_c, v3_t = _score(run_savings(ev, min_savings_minutes=20))

        rows.append({
            "Event":   ev["name"][:45],
            "GT":      gt_count,
            "V1_n":    n_v1,    "V1_asgn": f"{v1_a:.3f}", "V1_cnt": f"{v1_c:.3f}", "V1_tot": f"{v1_t:.3f}",
            "V2_n":    n_v2,    "V2_asgn": f"{v2_a:.3f}", "V2_cnt": f"{v2_c:.3f}", "V2_tot": f"{v2_t:.3f}",
            "V3_n":    n_v3,    "V3_asgn": f"{v3_a:.3f}", "V3_cnt": f"{v3_c:.3f}", "V3_tot": f"{v3_t:.3f}",
        })

    print()

    if not rows:
        print("No events with complete artifacts. Run prepare_realSuite.py first.")
        return

    cols  = ["Event", "GT",
             "V1_n", "V1_asgn", "V1_cnt", "V1_tot",
             "V2_n", "V2_asgn", "V2_cnt", "V2_tot",
             "V3_n", "V3_asgn", "V3_cnt", "V3_tot"]
    col_w = [46, 4,
             5, 8, 8, 8,
             5, 8, 8, 8,
             5, 8, 8, 8]

    header = "  ".join(c.ljust(w) for c, w in zip(cols, col_w))
    sep    = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, col_w)))
    print(sep)

    numeric_cols = [c for c in cols if c != "Event"]
    mean_row = {"Event": "MEAN"}
    for col in numeric_cols:
        vals = [float(r[col]) for r in rows]
        mean_row[col] = f"{sum(vals)/len(vals):.3f}"
    print("  ".join(str(mean_row.get(c, "")).ljust(w) for c, w in zip(cols, col_w)))

    # Verdict
    mean_v2  = sum(float(r["V2_tot"]) for r in rows) / len(rows)
    mean_v3  = sum(float(r["V3_tot"]) for r in rows) / len(rows)
    print(f"\nVerdict: V2={mean_v2:.3f}  V3_savings={mean_v3:.3f}  "
          f"→ {'SavingsSolver WINS — promote to V2' if mean_v3 > mean_v2 else 'No improvement — keep V2, delete experiments/savings_solver/'}")


if __name__ == "__main__":
    main()
