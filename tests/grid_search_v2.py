"""
Grid search for the best cluster_threshold_minutes for HumanStyleSolver.

Usage:
  python tests/grid_search_v2.py

Uses only pre-computed time_matrix.json — no OSRM or LLM calls.
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

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

    n = len(events_data)

    # V1 baseline
    v1_scores = []
    v1_asgn_scores = []
    v1_cnt_scores = []
    for i, (ev, gt) in enumerate(events_data):
        print(f"[V1] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
        sol = run_v1(ev)
        if sol:
            pred = solution_to_buses(sol, ev["schools"])
            v1_scores.append(combined_score(pred, gt))
            v1_asgn_scores.append(score_assignment(pred, gt))
            v1_cnt_scores.append(score_bus_count(pred, gt))
    print(f"[V1] done ({n}/{n})                                              ")
    v1_mean      = sum(v1_scores)      / len(v1_scores)      if v1_scores      else 0.0
    v1_asgn_mean = sum(v1_asgn_scores) / len(v1_asgn_scores) if v1_asgn_scores else 0.0
    v1_cnt_mean  = sum(v1_cnt_scores)  / len(v1_cnt_scores)  if v1_cnt_scores  else 0.0

    # V2 grid search
    results      = {}  # D → list of combined scores
    asgn_results = {}  # D → list of assignment scores
    cnt_results  = {}  # D → list of bus count scores
    for D in THRESHOLDS:
        scores = []
        asgn_scores = []
        cnt_scores = []
        for i, (ev, gt) in enumerate(events_data):
            print(f"[D={D:2d}] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
            sol = run_v2(ev, cluster_threshold_minutes=D)
            if sol:
                pred = solution_to_buses(sol, ev["schools"])
                scores.append(combined_score(pred, gt))
                asgn_scores.append(score_assignment(pred, gt))
                cnt_scores.append(score_bus_count(pred, gt))
        results[D]      = scores
        asgn_results[D] = asgn_scores
        cnt_results[D]  = cnt_scores
        print(f"[D={D:2d}] done ({n}/{n})                                          ")

    # Print per-event table
    col_w = [46] + [8] * (len(THRESHOLDS) + 1)
    header_parts = ["Event"] + [f"V1"] + [f"D={D}" for D in THRESHOLDS]
    header = "  ".join(str(h).ljust(w) for h, w in zip(header_parts, col_w))
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)

    for i, (ev, gt) in enumerate(events_data):
        v1_s = f"{v1_scores[i]:.3f}" if i < len(v1_scores) else "—"
        row = [ev["name"][:45], v1_s] + [
            f"{results[D][i]:.3f}" if i < len(results[D]) else "—"
            for D in THRESHOLDS
        ]
        print("  ".join(str(r).ljust(w) for r, w in zip(row, col_w)))

    print(sep)

    # Summary rows
    summary = ["MEAN", f"{v1_mean:.3f}"] + [
        f"{sum(results[D])/len(results[D]):.3f}" if results[D] else "—"
        for D in THRESHOLDS
    ]
    print("  ".join(str(s).ljust(w) for s, w in zip(summary, col_w)))

    mean_asgn = ["MEAN_ASGN", f"{v1_asgn_mean:.3f}"] + [
        f"{sum(asgn_results[D])/len(asgn_results[D]):.3f}" if asgn_results[D] else "—"
        for D in THRESHOLDS
    ]
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_asgn, col_w)))

    mean_cnt = ["MEAN_CNT", f"{v1_cnt_mean:.3f}"] + [
        f"{sum(cnt_results[D])/len(cnt_results[D]):.3f}" if cnt_results[D] else "—"
        for D in THRESHOLDS
    ]
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_cnt, col_w)))

    # Best D
    best_D = max(THRESHOLDS, key=lambda D: sum(results[D]) / len(results[D]) if results[D] else 0)
    best_mean = sum(results[best_D]) / len(results[best_D])
    print(f"\nBest D: {best_D} min  (mean score {best_mean:.3f} vs V1 {v1_mean:.3f})")


if __name__ == "__main__":
    main()
