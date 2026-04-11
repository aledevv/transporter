"""
Grid search for the best cluster_threshold_minutes for HumanStyleSolver.

Usage:
  python tests/grid_search_v2.py

Uses only pre-computed time_matrix.json — no OSRM or LLM calls.
"""
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
sys.path.insert(0, str(TESTS_DIR.parent))

from evaluate_realSuite import (
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
    _all_events,
)

THRESHOLDS = [5, 10, 15, 20, 25, 30, 40]


def _collect_scores(run_fn, events_data, label):
    """Run run_fn over all events, returning (tot, asgn, cnt) lists with None on failure."""
    n = len(events_data)
    tot, asgn, cnt = [], [], []
    for i, (ev, gt) in enumerate(events_data):
        print(f"[{label}] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
        sol = run_fn(ev)
        if sol:
            pred = solution_to_buses(sol, ev["schools"])
            a = score_assignment(pred, gt)
            c = score_bus_count(pred, gt)
            tot.append(0.6 * a + 0.4 * c)
            asgn.append(a)
            cnt.append(c)
        else:
            tot.append(None)
            asgn.append(None)
            cnt.append(None)
    print(f"[{label}] done ({n}/{n})                                          ")
    return tot, asgn, cnt


def _safe_mean(lst):
    """Mean of non-None values as a formatted string, or '—' if none."""
    vals = [x for x in lst if x is not None]
    return f"{sum(vals)/len(vals):.3f}" if vals else "—"


def _mean(lst):
    """Mean of non-None values as float, or 0.0 if none."""
    vals = [x for x in lst if x is not None]
    return sum(vals) / len(vals) if vals else 0.0


def main():
    events_data = []
    for ev_dir in _all_events():
        ev = load_event(ev_dir)
        if ev is None:
            continue
        gt = load_groundtruth(ev["gt_path"])
        events_data.append((ev, gt))

    if not events_data:
        print("No events ready. Run prepare_realSuite.py first.")
        return

    # V1 baseline
    v1_scores, v1_asgn_scores, v1_cnt_scores = _collect_scores(run_v1, events_data, "V1")

    # V2 grid search
    results      = {}
    asgn_results = {}
    cnt_results  = {}
    for D in THRESHOLDS:
        results[D], asgn_results[D], cnt_results[D] = _collect_scores(
            lambda ev, D=D: run_v2(ev, cluster_threshold_minutes=D),
            events_data, f"D={D:2d}",
        )

    # Print per-event table
    col_w = [46] + [8] * (len(THRESHOLDS) + 1)
    header_parts = ["Event"] + ["V1"] + [f"D={D}" for D in THRESHOLDS]
    header = "  ".join(str(h).ljust(w) for h, w in zip(header_parts, col_w))
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)

    for i, (ev, gt) in enumerate(events_data):
        v1_s = f"{v1_scores[i]:.3f}" if v1_scores[i] is not None else "—"
        row = [ev["name"][:45], v1_s] + [
            f"{results[D][i]:.3f}" if results[D][i] is not None else "—"
            for D in THRESHOLDS
        ]
        print("  ".join(str(r).ljust(w) for r, w in zip(row, col_w)))

    print(sep)

    summary   = ["MEAN",      _safe_mean(v1_scores)]      + [_safe_mean(results[D])      for D in THRESHOLDS]
    mean_asgn = ["MEAN_ASGN", _safe_mean(v1_asgn_scores)] + [_safe_mean(asgn_results[D]) for D in THRESHOLDS]
    mean_cnt  = ["MEAN_CNT",  _safe_mean(v1_cnt_scores)]  + [_safe_mean(cnt_results[D])  for D in THRESHOLDS]
    print("  ".join(str(s).ljust(w) for s, w in zip(summary,   col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_asgn, col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_cnt,  col_w)))

    # Best D
    best_D    = max(THRESHOLDS, key=lambda D: _mean(results[D]))
    best_mean = _mean(results[best_D])
    print(f"\nBest D: {best_D} min  (mean score {best_mean:.3f} vs V1 {_mean(v1_scores):.3f})")


if __name__ == "__main__":
    main()
