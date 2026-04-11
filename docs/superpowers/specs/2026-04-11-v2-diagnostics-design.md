# V2 Diagnostics Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand evaluation output to show per-component scores (assignment Jaccard + bus count) so we can diagnose whether V2 errors come from wrong groupings or wrong bus count.

**Architecture:** Pure presentational change — no new logic. `score_assignment` and `score_bus_count` are already exported from `evaluate_realSuite.py`; we just call them separately and display the results in two places: the standalone evaluator table and the grid search summary rows.

**Tech Stack:** Python, pandas, existing scoring functions in `evaluate_realSuite.py`.

---

## Scope

Two files change, both presentation-only:

- **`tests/evaluate_realSuite.py`** — `main()` table expanded with per-component columns
- **`tests/grid_search_v2.py`** — two extra summary rows appended after MEAN

No new functions needed. No changes to scoring logic, solver, or tests.

---

## File 1: `tests/evaluate_realSuite.py` — expanded table

### Current columns
```
Event | GT buses | V1 buses | V1 score | V2 buses | V2 score
```

### New columns
```
Event | GT | V1_n | V1_asgn | V1_cnt | V1_tot | V2_n | V2_asgn | V2_cnt | V2_tot
```

Field definitions:
- `GT` — number of non-empty buses in groundtruth (`len([v for v in gt.values() if v])`)
- `V1_n` / `V2_n` — number of non-empty predicted buses
- `V1_asgn` / `V2_asgn` — `score_assignment(pred, gt)` (Hungarian Jaccard, 0–1)
- `V1_cnt` / `V2_cnt` — `score_bus_count(pred, gt)` (1 − |pred−gt|/gt, 0–1)
- `V1_tot` / `V2_tot` — `combined_score(pred, gt)` (0.6×asgn + 0.4×cnt)

MEAN row at the bottom averages all numeric columns.

Column widths (for fixed-width formatting): `Event=46`, all numeric=8.

### Implementation detail
In `main()`, replace the current per-solver score block with:
```python
rows.append({
    "Event": ev["name"][:45],
    "GT": gt_count,
    "V1_n": n_v1, "V1_asgn": f"{score_assignment(pred_v1, gt):.3f}",
    "V1_cnt": f"{score_bus_count(pred_v1, gt):.3f}", "V1_tot": f"{s_v1:.3f}",
    "V2_n": n_v2, "V2_asgn": f"{score_assignment(pred_v2, gt):.3f}",
    "V2_cnt": f"{score_bus_count(pred_v2, gt):.3f}", "V2_tot": f"{s_v2:.3f}",
})
```

MEAN row: average each numeric column across all rows (skip "—" values).

---

## File 2: `tests/grid_search_v2.py` — extra summary rows

After the existing MEAN row, append two rows:

```
MEAN_ASGN   {v1_asgn_mean}  {d5_asgn_mean}  {d10_asgn_mean}  ...
MEAN_CNT    {v1_cnt_mean}   {d5_cnt_mean}   {d10_cnt_mean}   ...
```

This requires accumulating `score_assignment` and `score_bus_count` separately per D in the grid search loop, in addition to the already-collected `combined_score`.

```python
asgn_results = {}   # D → list of score_assignment values
cnt_results  = {}   # D → list of score_bus_count values
```

And for the V1 baseline:
```python
v1_asgn_scores = []
v1_cnt_scores  = []
```

The MEAN_ASGN and MEAN_CNT rows follow the same column layout as MEAN (one column per D, plus V1 baseline in the second column).

---

## What This Enables

After running `python tests/evaluate_realSuite.py` you'll see which events have:
- High `asgn`, low `cnt` → V2 groups correctly but uses wrong number of buses
- Low `asgn`, high `cnt` → right number of buses but wrong groupings
- Both low → fundamental mismatch

After running `python tests/grid_search_v2.py` you'll see whether increasing D improves assignment (grouping) or bus count or both — guiding the next round of V2 improvements.

---

## Out of Scope

- No changes to `score_assignment`, `score_bus_count`, `combined_score`
- No changes to solver logic
- No new test files (these are diagnostic scripts, not pytest tests)
- No frontend changes
