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
