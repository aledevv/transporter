"""
Grid search over ImprovedVRPSolver hyperparameters.

Usage (from project root):
    python3 experiments/v1_improved/grid_search.py

Sweeps:
    fixed_vehicle_cost  : [300, 600, 1200, 2400]
    time_limit_seconds  : [20, 30]
    (slack_minutes=20 and penalty_per_minute=1000 are fixed)

Baselines: V1-current and V2-current from evaluate_realSuite.

Output columns:
    config        — parameter label
    combined      — mean combined score (0.6×assignment + 0.4×bus_count)
    tot_km        — total km summed over all events and all buses
    max_min       — maximum single-route duration (minutes) across all events
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

# Make project root importable
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from evaluate_realSuite import (
    _all_events,
    _build_solver_matrix,
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    solution_to_buses,
)

from experiments.v1_improved.optimizer_v1_improved import ImprovedVRPSolver

REALSUITE_DIR = ROOT / "tests" / "realSuite"

# -----------------------------------------------------------------------
# Distance-matrix loader (extends load_event data)
# -----------------------------------------------------------------------

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    """Haversine great-circle distance in metres (integer)."""
    R = 6_371_000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return int(R * 2 * math.asin(math.sqrt(a)))


def load_or_compute_distance_matrix(
    ev_dir: Path, schools: list[dict]
) -> list[list[int]] | None:
    """
    Load distance_matrix.json if present; otherwise compute haversine distances
    from coords.json + config.json (destination lat/lon).

    Returns an (N+1)×(N+1) matrix [destination=0, schools=1..N] in metres,
    or None if neither source is available.
    """
    # Try JSON first
    p = ev_dir / "distance_matrix.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))

    # Fallback: haversine from coords.json + config.json
    coords_path = ev_dir / "coords.json"
    config_path = ev_dir / "config.json"
    if not coords_path.exists() or not config_path.exists():
        return None

    coords = json.loads(coords_path.read_text(encoding="utf-8"))
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    dest_lat = cfg.get("destination_lat")
    dest_lon = cfg.get("destination_lon")
    if dest_lat is None or dest_lon is None:
        return None

    n = len(schools)
    # Build (N+1)×(N+1): index 0=destination, 1..N=schools
    locations: list[tuple[float, float]] = [(dest_lat, dest_lon)]
    for s in schools:
        c = coords.get(s["name"])
        if c is None:
            return None  # missing coordinate → give up
        locations.append((c["lat"], c["lon"]))

    matrix: list[list[int]] = []
    for i in range(n + 1):
        row = []
        for j in range(n + 1):
            if i == j:
                row.append(0)
            else:
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                row.append(_haversine_m(lat1, lon1, lat2, lon2))
        matrix.append(row)
    return matrix


def load_arrival_time(ev_dir: Path) -> str:
    """Read arrival_time from config.json; fall back to '12:00'."""
    config_path = ev_dir / "config.json"
    if not config_path.exists():
        return "12:00"
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    return cfg.get("arrival_time", "12:00")


# -----------------------------------------------------------------------
# Route metrics helpers
# -----------------------------------------------------------------------

def _route_km(route: dict, dist_matrix: list[list[int]]) -> float:
    """Total km for a single route using the distance matrix (values in metres)."""
    stops = route["stops"]
    total_m = 0
    for i in range(len(stops) - 1):
        total_m += dist_matrix[stops[i]["node"]][stops[i + 1]["node"]]
    return total_m / 1000.0


def _route_minutes(route: dict, time_matrix: list[list[int]]) -> float:
    """Total travel time in minutes for a single route."""
    stops = route["stops"]
    total_s = 0
    for i in range(len(stops) - 1):
        total_s += time_matrix[stops[i]["node"]][stops[i + 1]["node"]]
    return total_s / 60.0


def compute_route_metrics(
    solution: dict | None,
    dist_matrix: list[list[int]],
    time_matrix: list[list[int]],
) -> tuple[float, float]:
    """
    Returns (total_km, max_route_minutes) for one solution.
    If solution is None, returns (0.0, 0.0).
    """
    if solution is None:
        return 0.0, 0.0
    km_total = sum(_route_km(r, dist_matrix) for r in solution["routes"])
    max_min = max(
        (_route_minutes(r, time_matrix) for r in solution["routes"]),
        default=0.0,
    )
    return km_total, max_min


# -----------------------------------------------------------------------
# ImprovedVRPSolver runner (mirrors run_v1 signature)
# -----------------------------------------------------------------------

def run_v1_improved(
    ev: dict,
    dist_matrix_full: list[list[int]],
    solver: ImprovedVRPSolver,
    arrival_time_str: str,
) -> dict | None:
    """Run ImprovedVRPSolver on one event. Returns solution or None."""
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]

    # Build (N+2)×(N+2) matrices: dest=0, schools=1..n, dummy=n+1
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)

    # Build distance matrix: start from the (N+1)×(N+1) stored version, add dummy col/row
    dm_ext = [row[:] + [0] for row in dist_matrix_full]
    dm_ext.append([0] * (n + 2))

    demands = [0] + [s["demand"] for s in schools] + [0]
    total = sum(s["demand"] for s in schools)
    num_vehicles = math.ceil(total / capacity) + 3
    dummy_idx = n + 1

    return solver.solve(
        time_matrix=time_matrix,
        distance_matrix=dm_ext,
        demands=demands,
        num_vehicles=num_vehicles,
        starts=[dummy_idx] * num_vehicles,
        ends=[0] * num_vehicles,
        arrival_time_str=arrival_time_str,
        bus_capacity=capacity,
    )


# -----------------------------------------------------------------------
# Event evaluation (single solver call)
# -----------------------------------------------------------------------

def evaluate_event(
    ev: dict,
    ev_dir: Path,
    solver,
    solver_type: str,
    dist_matrix_full: list[list[int]] | None,
    arrival_time_str: str,
) -> tuple[float, float, float]:
    """
    Run the given solver on one event and return (combined, tot_km, max_min).
    solver_type: 'v1' | 'v2' | 'v1_improved'
    """
    n = len(ev["schools"])
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)

    if solver_type == "v1":
        solution = run_v1(ev)
    elif solver_type == "v2":
        solution = run_v2(ev)
    else:  # v1_improved
        if dist_matrix_full is None:
            return 0.0, 0.0, 0.0
        solution = run_v1_improved(ev, dist_matrix_full, solver, arrival_time_str)

    gt = load_groundtruth(ev["gt_path"])
    if solution is None:
        return 0.0, 0.0, 0.0

    pred = solution_to_buses(solution, ev["schools"])
    comb = combined_score(pred, gt)

    if dist_matrix_full is not None:
        dm_ext = [row[:] + [0] for row in dist_matrix_full]
        dm_ext.append([0] * (n + 2))
        tot_km, max_min = compute_route_metrics(solution, dm_ext, time_matrix)
    else:
        tot_km, max_min = 0.0, 0.0

    return comb, tot_km, max_min


# -----------------------------------------------------------------------
# Main grid search
# -----------------------------------------------------------------------

FIXED_VEHICLE_COSTS = [300, 600, 1200, 2400]
TIME_LIMITS = [20, 30]
SLACK_MINUTES = 20
PENALTY_PER_MINUTE = 1000


def _progress(current: int, total: int, label: str = "", width: int = 30) -> None:
    filled = int(width * current / total) if total else 0
    bar = "#" * filled + "-" * (width - filled)
    print(f"\r[{bar}] {current}/{total}  {label:<45}", end="", flush=True)


def main() -> None:
    events = _all_events()
    n_events = len(events)

    # ---- load all event data once ---------------------------------
    print(f"Loading {n_events} events …")
    loaded: list[dict] = []
    for ev_dir in events:
        ev = load_event(ev_dir)
        if ev is None:
            continue
        dist = load_or_compute_distance_matrix(ev_dir, ev["schools"])
        arrival = load_arrival_time(ev_dir)
        loaded.append({"ev": ev, "dist": dist, "arrival": arrival, "dir": ev_dir})

    if not loaded:
        print("No complete events found. Run prepare_realSuite.py first.")
        return

    n_loaded = len(loaded)
    print(f"Loaded {n_loaded} events with all artifacts.\n")

    # ---- build configs --------------------------------------------
    configs: list[dict] = []
    configs.append({"label": "V1 (current)", "type": "v1"})
    configs.append({"label": "V2 (current)", "type": "v2"})
    for fvc in FIXED_VEHICLE_COSTS:
        for tl in TIME_LIMITS:
            configs.append(
                {
                    "label": f"fvc={fvc:<4} / tl={tl}",
                    "type": "v1_improved",
                    "fvc": fvc,
                    "tl": tl,
                }
            )

    # ---- run all configs ------------------------------------------
    results: list[dict] = []

    for cfg in configs:
        label = cfg["label"]
        solver_type = cfg["type"]
        solver = None

        if solver_type == "v1_improved":
            solver = ImprovedVRPSolver(
                fixed_vehicle_cost=cfg["fvc"],
                slack_minutes=SLACK_MINUTES,
                penalty_per_minute=PENALTY_PER_MINUTE,
                time_limit_seconds=cfg["tl"],
            )

        print(f"Running: {label}")
        comb_vals, km_vals, mm_vals = [], [], []

        for idx, item in enumerate(loaded, 1):
            _progress(idx, n_loaded, item["ev"]["name"][:40])
            c, k, m = evaluate_event(
                item["ev"],
                item["dir"],
                solver,
                solver_type,
                item["dist"],
                item["arrival"],
            )
            comb_vals.append(c)
            km_vals.append(k)
            mm_vals.append(m)

        print()  # newline after progress bar

        results.append(
            {
                "label": label,
                "combined": sum(comb_vals) / len(comb_vals) if comb_vals else 0.0,
                "tot_km": sum(km_vals),
                "max_min": max(mm_vals) if mm_vals else 0.0,
            }
        )

    # ---- print table ----------------------------------------------
    col_w = [22, 10, 10, 10]
    cols = ["config", "combined", "tot_km", "max_min"]
    header = "  ".join(c.ljust(w) for c, w in zip(cols, col_w))
    sep = "-" * len(header)
    print()
    print(sep)
    print(header)
    print(sep)
    for r in results:
        row = [
            r["label"],
            f"{r['combined']:.3f}",
            f"{r['tot_km']:.1f}",
            f"{r['max_min']:.1f}",
        ]
        print("  ".join(v.ljust(w) for v, w in zip(row, col_w)))
    print(sep)
    print()
    print("Verdict: choose config minimising tot_km without losing >0.015 combined vs V2 (current).")


if __name__ == "__main__":
    main()
