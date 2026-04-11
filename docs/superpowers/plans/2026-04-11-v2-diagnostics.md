# V2 Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand evaluation scripts to show per-component scores (assignment Jaccard + bus count) so we can diagnose whether V2 errors come from wrong groupings or wrong bus count.

**Architecture:** Pure presentational change — two scripts modified, zero new logic. `score_assignment` and `score_bus_count` already exist in `evaluate_realSuite.py`; we call them separately and display results in both the standalone evaluator table and the grid search summary.

**Tech Stack:** Python, existing scoring functions in `tests/evaluate_realSuite.py`.

---

## Files Modified

- **`tests/evaluate_realSuite.py`** lines 212–272 — replace `main()` body with expanded table
- **`tests/grid_search_v2.py`** — add imports, accumulate per-component scores in loops, print two extra summary rows

No new files. No test files (these are diagnostic scripts, not library code).

---

### Task 1: Expand evaluate_realSuite.py table

**Files:**
- Modify: `tests/evaluate_realSuite.py` (function `main`, lines 212–272)

**Context:** The current table has 6 columns (`Event`, `GT buses`, `V1 buses`, `V1 score`, `V2 buses`, `V2 score`). We replace it with 10 columns that break the combined score into its two components for both V1 and V2.

- [ ] **Step 1: Replace `main()` in `tests/evaluate_realSuite.py`**

Replace the entire `main()` function (from `def main():` through the last `print(f"Mean V2: ...")` line) with:

```python
def main():
    events = _all_events()
    rows = []

    for ev_dir in events:
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
            v1_tot  = combined_score(pred_v1, gt)
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
            v2_tot  = combined_score(pred_v2, gt)
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

    # MEAN row — average every numeric column
    numeric_cols = ["GT", "V1_n", "V1_asgn", "V1_cnt", "V1_tot", "V2_n", "V2_asgn", "V2_cnt", "V2_tot"]
    mean_row = {"Event": "MEAN"}
    for col in numeric_cols:
        vals = [float(r[col]) for r in rows]
        mean_row[col] = f"{sum(vals)/len(vals):.3f}"
    print("  ".join(str(mean_row.get(c, "")).ljust(w) for c, w in zip(cols, col_w)))
```

- [ ] **Step 2: Verify the script runs and output has 10 columns**

```bash
cd /Users/dev/Desktop/busplan
python tests/evaluate_realSuite.py 2>/dev/null | head -5
```

Expected: first line is a separator, second line contains `Event`, `GT`, `V1_n`, `V1_asgn`, `V1_cnt`, `V1_tot`, `V2_n`, `V2_asgn`, `V2_cnt`, `V2_tot`. No Python errors.

- [ ] **Step 3: Commit**

```bash
git add tests/evaluate_realSuite.py
git commit -m "feat: expand evaluator table with per-component scores (asgn, cnt, tot)"
```

---

### Task 2: Add MEAN_ASGN and MEAN_CNT rows to grid search

**Files:**
- Modify: `tests/grid_search_v2.py`

**Context:** The grid search currently prints one summary row (`MEAN`) with combined scores per D value. We add two more rows breaking it down into assignment score and bus count score, so you can see which component D affects.

- [ ] **Step 1: Expand imports in `tests/grid_search_v2.py`**

Replace:
```python
from evaluate_realSuite import (
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    solution_to_buses,
    _all_events,
)
```

With:
```python
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
```

- [ ] **Step 2: Accumulate per-component scores in the V1 baseline loop**

Replace the V1 baseline block:
```python
    # V1 baseline
    v1_scores = []
    for i, (ev, gt) in enumerate(events_data):
        print(f"[V1] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
        sol = run_v1(ev)
        if sol:
            pred = solution_to_buses(sol, ev["schools"])
            v1_scores.append(combined_score(pred, gt))
    print(f"[V1] done ({n}/{n})                                              ")
    v1_mean = sum(v1_scores) / len(v1_scores) if v1_scores else 0.0
```

With:
```python
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
```

- [ ] **Step 3: Accumulate per-component scores in the V2 grid search loop**

Replace the V2 grid search block:
```python
    # V2 grid search
    results = {}  # threshold → list of scores
    for D in THRESHOLDS:
        scores = []
        for i, (ev, gt) in enumerate(events_data):
            print(f"[D={D:2d}] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
            sol = run_v2(ev, cluster_threshold_minutes=D)
            if sol:
                pred = solution_to_buses(sol, ev["schools"])
                scores.append(combined_score(pred, gt))
        results[D] = scores
        print(f"[D={D:2d}] done ({n}/{n})                                          ")
```

With:
```python
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
```

- [ ] **Step 4: Print MEAN_ASGN and MEAN_CNT rows after the existing MEAN row**

The existing code ends with:
```python
    # Summary row
    summary = ["MEAN", f"{v1_mean:.3f}"] + [
        f"{sum(results[D])/len(results[D]):.3f}" if results[D] else "—"
        for D in THRESHOLDS
    ]
    print("  ".join(str(s).ljust(w) for s, w in zip(summary, col_w)))

    # Best D
    best_D = max(THRESHOLDS, key=lambda D: sum(results[D]) / len(results[D]) if results[D] else 0)
    best_mean = sum(results[best_D]) / len(results[best_D])
    print(f"\nBest D: {best_D} min  (mean score {best_mean:.3f} vs V1 {v1_mean:.3f})")
```

Replace with:
```python
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
```

- [ ] **Step 5: Verify the script imports without errors**

```bash
cd /Users/dev/Desktop/busplan
python -c "import tests.grid_search_v2" 2>&1
```

Expected: no output (no import errors).

- [ ] **Step 6: Commit**

```bash
git add tests/grid_search_v2.py
git commit -m "feat: add MEAN_ASGN and MEAN_CNT rows to grid search output"
```
