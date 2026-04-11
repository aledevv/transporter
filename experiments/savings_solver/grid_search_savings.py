"""
Grid search for min_savings_minutes parameter in SavingsSolver.

Usage (from project root):
  python experiments/savings_solver/grid_search_savings.py

Uses pre-computed time_matrix.json — no OSRM or LLM calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).parent
_ROOT = _HERE.parent.parent
_TESTS = _ROOT / "tests"
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_TESTS))

from evaluate_realSuite import (
    _all_events,
    load_event,
    load_groundtruth,
    run_v1,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from evaluate_savings import run_savings

THRESHOLDS = [0, 5, 10, 15, 20]


def _collect_scores(run_fn, events_data, label):
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
    vals = [x for x in lst if x is not None]
    return f"{sum(vals)/len(vals):.3f}" if vals else "—"


def _mean(lst):
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

    v1_scores, v1_asgn, v1_cnt = _collect_scores(run_v1, events_data, "V1")

    results = {}
    asgn_results = {}
    cnt_results = {}
    for S in THRESHOLDS:
        results[S], asgn_results[S], cnt_results[S] = _collect_scores(
            lambda ev, S=S: run_savings(ev, min_savings_minutes=S),
            events_data, f"S={S:2d}",
        )

    col_w = [46] + [8] * (len(THRESHOLDS) + 1)
    header_parts = ["Event", "V1"] + [f"S={S}" for S in THRESHOLDS]
    header = "  ".join(str(h).ljust(w) for h, w in zip(header_parts, col_w))
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)

    for i, (ev, _) in enumerate(events_data):
        v1_s = f"{v1_scores[i]:.3f}" if v1_scores[i] is not None else "—"
        row = [ev["name"][:45], v1_s] + [
            f"{results[S][i]:.3f}" if results[S][i] is not None else "—"
            for S in THRESHOLDS
        ]
        print("  ".join(str(r).ljust(w) for r, w in zip(row, col_w)))

    print(sep)

    summary   = ["MEAN",      _safe_mean(v1_scores)] + [_safe_mean(results[S])      for S in THRESHOLDS]
    mean_asgn = ["MEAN_ASGN", _safe_mean(v1_asgn)]   + [_safe_mean(asgn_results[S]) for S in THRESHOLDS]
    mean_cnt  = ["MEAN_CNT",  _safe_mean(v1_cnt)]     + [_safe_mean(cnt_results[S])  for S in THRESHOLDS]
    print("  ".join(str(s).ljust(w) for s, w in zip(summary,   col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_asgn, col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_cnt,  col_w)))

    best_S    = max(THRESHOLDS, key=lambda S: _mean(results[S]))
    best_mean = _mean(results[best_S])
    v1_mean   = _mean(v1_scores)
    print(f"\nBest S: {best_S} min  (mean score {best_mean:.3f} vs V1 {v1_mean:.3f})")


if __name__ == "__main__":
    main()
