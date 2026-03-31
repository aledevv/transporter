"""
Compare the VRP planner output against human expert bus plans.

For each real dataset, computes quality metrics for both plans and prints
a side-by-side comparison so you can judge whether the planner is better
or worse than the expert solution.

Metrics are all computable offline using pre-geocoded haversine distances
(no OSRM or geocoding network calls needed).

Usage: ./venv/bin/python3 scripts/compare_plans.py
"""
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
from optimizer import VRPSolver

TESTS_DIR = Path(__file__).parent.parent / "tests"
TRENTO_LAT = 46.0707
TRENTO_LON = 11.1210

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class SchoolStop:
    name: str
    demand: int
    lat: float
    lon: float


@dataclass
class BusRoute:
    bus_id: str
    stops: list  # list[SchoolStop]
    capacity: int

    @property
    def load(self):
        return sum(s.demand for s in self.stops)


@dataclass
class Plan:
    label: str
    routes: list  # list[BusRoute]
    dest_lat: float
    dest_lon: float


@dataclass
class Metrics:
    bus_count: int
    avg_util_pct: float       # mean(load/capacity)*100
    std_util_pct: float       # stddev of load/capacity * 100
    avg_compactness_km: float # mean of per-bus avg pairwise haversine distance (km)
    avg_detour: float         # mean of (chain_dist / direct_dist) per bus
    total_dist_km: float      # sum of all route haversine chains (km)
    worst_overload: float     # max(load/capacity)


# ---------------------------------------------------------------------------
# Haversine utilities
# ---------------------------------------------------------------------------

def _haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _build_time_matrix(coords, speed_kmh=50):
    n = len(coords)
    m = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                d = _haversine_m(coords[i][0], coords[i][1], coords[j][0], coords[j][1])
                m[i][j] = int(d / (speed_kmh * 1000 / 3600))
    return m


# ---------------------------------------------------------------------------
# Parsing expert output.xlsx
# ---------------------------------------------------------------------------

# Maps expert output school names → coords.json keys where they differ
EXPERT_ALIASES = {
    # real1 differences
    "IS Primiero":          "IS Primier",
    'IIS "Lorenzo Guetti"': 'Istituto di Istruzione Superiore "Lorenzo Guetti"',
    "CFP ENAIP Tione":      "Centro Formazione Professionale ENAIP - Tione di Trento",
    # real2 has no differences
}


def _resolve_name(expert_name, coords):
    """Resolve an expert xlsx school name to a coords.json key."""
    name = str(expert_name).strip()
    if name in coords:
        return name
    alias = EXPERT_ALIASES.get(name)
    if alias and alias in coords:
        return alias
    # Fuzzy: find the single coords key that contains the expert name as substring
    candidates = [k for k in coords if name.lower() in k.lower() or k.lower() in name.lower()]
    if len(candidates) == 1:
        return candidates[0]
    raise KeyError(
        f"Cannot resolve expert name '{name}' to coords.json key. "
        f"Candidates: {candidates or 'none'}"
    )


def parse_expert_xlsx(path, coords, capacity, dest_lat, dest_lon, format_version):
    """
    Parse an expert output.xlsx into a Plan.

    format_version='real1': bus id col is a color name, separator rows detected
                             by None in col 1 or '---' or 'Totale' prefix.
    format_version='real2': bus id col is 'Bus N'.
    """
    df = pd.read_excel(path)
    routes_map = {}  # bus_id → list[SchoolStop]
    bus_order = []

    bus_col = df.columns[0]
    name_col = df.columns[1]
    pax_col = df.columns[3]

    for _, row in df.iterrows():
        bus_id = str(row[bus_col]).strip() if pd.notna(row[bus_col]) else ""
        school_name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ""
        pax = row[pax_col]

        # Skip separator rows
        if not bus_id or bus_id == "---":
            continue
        if bus_id.startswith("Totale") or school_name in ("---", "", "nan"):
            continue
        if not pd.notna(pax) or not str(pax).strip().lstrip("-").isdigit():
            continue

        try:
            coords_key = _resolve_name(school_name, coords)
        except KeyError as e:
            print(f"  [WARN] {e} — skipping row")
            continue

        c = coords[coords_key]
        stop = SchoolStop(
            name=coords_key,
            demand=int(pax),
            lat=c["lat"],
            lon=c["lon"],
        )
        if bus_id not in routes_map:
            routes_map[bus_id] = []
            bus_order.append(bus_id)
        routes_map[bus_id].append(stop)

    routes = [
        BusRoute(bus_id=bid, stops=routes_map[bid], capacity=capacity)
        for bid in bus_order
    ]
    return Plan(label="Expert", routes=routes, dest_lat=dest_lat, dest_lon=dest_lon)


# ---------------------------------------------------------------------------
# Load dataset + run VRP
# ---------------------------------------------------------------------------

def load_dataset(dataset_dir):
    df = pd.read_excel(dataset_dir / "input.xlsx")
    name_col = "Nome" if "Nome" in df.columns else "Nome (della scuola)"
    coords = json.loads((dataset_dir / "coords.json").read_text(encoding="utf-8"))
    schools = []
    for _, row in df.iterrows():
        name = str(row[name_col]).strip()
        c = coords[name]
        schools.append(SchoolStop(name=name, demand=int(row["Partecipanti"]),
                                   lat=c["lat"], lon=c["lon"]))
    matrix_path = dataset_dir / "time_matrix.json"
    if matrix_path.exists():
        time_matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        print(f"  Time matrix: Google Maps road distances (committed fixture)")
    else:
        time_matrix = None
        print(f"  Time matrix: haversine fallback (run prepare_fixtures.py to get real distances)")
    return schools, coords, time_matrix


def run_vrp(schools, capacity, time_matrix=None, dest_lat=TRENTO_LAT, dest_lon=TRENTO_LON):
    """Run VRPSolver and return a Plan (same setup as test_real_cases.py)."""
    n = len(schools)
    dummy_idx = n + 1

    if time_matrix is not None:
        real_matrix = [row[:] + [0] for row in time_matrix]
        real_matrix.append([0] * (n + 2))
    else:
        real_coords = [(dest_lat, dest_lon)] + [(s.lat, s.lon) for s in schools]
        real_matrix = _build_time_matrix(real_coords)
        for row in real_matrix:
            row.append(0)
        real_matrix.append([0] * (n + 2))

    demands = [0] + [s.demand for s in schools] + [0]
    total_demand = sum(s.demand for s in schools)
    num_vehicles = math.ceil(total_demand / capacity) + 3

    solver = VRPSolver(
        time_matrix=real_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        num_vehicles=num_vehicles,
        depot_index=0,
        fixed_vehicle_cost=3600,
        starts=[dummy_idx] * num_vehicles,
        ends=[0] * num_vehicles,
        institutes=None,
    )
    sol = solver.solve()
    if sol is None:
        raise RuntimeError("VRPSolver returned no solution")

    routes = []
    for route in sol["routes"]:
        stops = [
            schools[s["node"] - 1]
            for s in route["stops"]
            if s["node"] not in (0, dummy_idx)
        ]
        if stops:
            routes.append(BusRoute(
                bus_id=f"Bus {route['vehicle_id'] + 1}",
                stops=stops,
                capacity=capacity,
            ))

    return Plan(label="VRP", routes=routes, dest_lat=dest_lat, dest_lon=dest_lon)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _mean(vals):
    return sum(vals) / len(vals) if vals else 0.0


def _stddev(vals):
    if len(vals) < 2:
        return 0.0
    m = _mean(vals)
    variance = sum((v - m) ** 2 for v in vals) / len(vals)
    return math.sqrt(variance)


def compute_metrics(plan):
    utilizations = [r.load / r.capacity for r in plan.routes]
    compactnesses = []
    detours = []
    total_dist_m = 0.0

    for route in plan.routes:
        stops = route.stops
        if not stops:
            continue

        # Geographic compactness: mean pairwise haversine among schools on this bus
        if len(stops) > 1:
            pairs = [
                _haversine_m(stops[i].lat, stops[i].lon, stops[j].lat, stops[j].lon)
                for i in range(len(stops))
                for j in range(i + 1, len(stops))
            ]
            compactnesses.append(_mean(pairs) / 1000)  # km
        else:
            compactnesses.append(0.0)

        # Chain distance: school[0] → school[1] → ... → destination
        chain = 0.0
        for i in range(len(stops) - 1):
            chain += _haversine_m(stops[i].lat, stops[i].lon, stops[i+1].lat, stops[i+1].lon)
        chain += _haversine_m(stops[-1].lat, stops[-1].lon, plan.dest_lat, plan.dest_lon)
        total_dist_m += chain

        # Detour: chain / direct distance from first school to destination
        direct = max(
            _haversine_m(stops[0].lat, stops[0].lon, plan.dest_lat, plan.dest_lon),
            1.0  # floor to avoid division by zero
        )
        detours.append(chain / direct)

    return Metrics(
        bus_count=len(plan.routes),
        avg_util_pct=_mean(utilizations) * 100,
        std_util_pct=_stddev(utilizations) * 100,
        avg_compactness_km=_mean(compactnesses),
        avg_detour=_mean(detours),
        total_dist_km=total_dist_m / 1000,
        worst_overload=max(utilizations) if utilizations else 0.0,
    )


# ---------------------------------------------------------------------------
# Similarity between two plans
# ---------------------------------------------------------------------------

def _assignment_map(plan):
    """Return {school_name: bus_id} for every school in the plan."""
    mapping = {}
    for route in plan.routes:
        for stop in route.stops:
            mapping[stop.name] = route.bus_id
    return mapping


def pairwise_similarity(plan_a, plan_b):
    """
    Compare two plans as clusterings using pairwise co-assignment:
    for every pair of schools present in BOTH plans, check whether each plan
    puts them on the same bus.

    Returns (precision, recall, f1, agreement_pct) where:
      recall    = of pairs the EXPERT groups together, what % does VRP agree on?
      precision = of pairs the VRP groups together, what % does the expert agree on?
      f1        = harmonic mean of the two
      agreement = % of all pairs where both plans agree (same-bus or different-bus)
    """
    map_a = _assignment_map(plan_a)   # expert
    map_b = _assignment_map(plan_b)   # VRP

    common = sorted(set(map_a) & set(map_b))
    n = len(common)
    if n < 2:
        return 0.0, 0.0, 0.0, 0.0

    tp = fp = fn = tn = 0
    for i in range(n):
        for j in range(i + 1, n):
            a_same = map_a[common[i]] == map_a[common[j]]
            b_same = map_b[common[i]] == map_b[common[j]]
            if a_same and b_same:
                tp += 1
            elif not a_same and b_same:
                fp += 1
            elif a_same and not b_same:
                fn += 1
            else:
                tn += 1

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1        = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    agreement = (tp + tn) / (tp + fp + fn + tn)
    return precision, recall, f1, agreement


def best_bus_matches(expert_plan, vrp_plan):
    """
    For each expert bus, find the VRP bus with highest Jaccard overlap.
    Returns list of (expert_bus_id, vrp_bus_id, jaccard, expert_schools, vrp_schools).
    """
    results = []
    for er in expert_plan.routes:
        e_set = {s.name for s in er.stops}
        best_j, best_vbus, best_vset = 0.0, "—", set()
        for vr in vrp_plan.routes:
            v_set = {s.name for s in vr.stops}
            inter = len(e_set & v_set)
            union = len(e_set | v_set)
            j = inter / union if union > 0 else 0.0
            if j > best_j:
                best_j, best_vbus, best_vset = j, vr.bus_id, v_set
        results.append((er.bus_id, best_vbus, best_j, e_set, best_vset))
    return results


def print_similarity(expert_plan, vrp_plan):
    """Print the similarity section below the metrics table."""
    precision, recall, f1, agreement = pairwise_similarity(expert_plan, vrp_plan)

    print("  Similarity to expert plan:")
    print(f"    Pairwise F1 score  : {f1*100:5.1f}%   (0% = completely different, 100% = identical)")
    print(f"    Pair agreement     : {agreement*100:5.1f}%   (% of school-pairs where both plans agree)")
    print(f"    Recall (VRP∩Expert): {recall*100:5.1f}%   (of expert same-bus pairs, VRP keeps together)")
    print(f"    Precision          : {precision*100:5.1f}%   (of VRP same-bus pairs, expert agrees)")
    print()

    matches = best_bus_matches(expert_plan, vrp_plan)
    print("  Best VRP match per expert bus (Jaccard overlap):")
    print(f"    {'Expert bus':<20} {'Best VRP bus':<14} {'Jaccard':>7}  Schools in common")
    print(f"    {'-'*20} {'-'*14} {'-'*7}  {'-'*30}")
    for e_bus, v_bus, j, e_set, v_set in matches:
        common_schools = sorted(e_set & v_set)
        common_str = ", ".join(s.split()[-1] for s in common_schools[:3])
        if len(common_schools) > 3:
            common_str += f" (+{len(common_schools)-3})"
        print(f"    {e_bus:<20} {v_bus:<14} {j*100:6.0f}%  {common_str}")
    print()


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _winner(expert_val, vrp_val, lower_is_better):
    """Return (expert_str, vrp_str) with '*' on the better value."""
    if lower_is_better:
        better_expert = expert_val < vrp_val
        better_vrp = vrp_val < expert_val
    else:
        better_expert = expert_val > vrp_val
        better_vrp = vrp_val > expert_val
    e_mark = " *" if better_expert else "  "
    v_mark = " *" if better_vrp else "  "
    return e_mark, v_mark


def print_comparison(dataset_label, expert: Metrics, vrp: Metrics):
    W = 32  # label column width
    N = 10  # value column width

    sep = "-" * (W + N * 2 + 20)
    header = f"{'Metric':<{W}}  {'Expert':>{N}}  {'VRP':>{N}}  {'Winner'}"

    print(f"\n{'=' * len(sep)}")
    print(f"  {dataset_label}")
    print(f"{'=' * len(sep)}")
    print(header)
    print(sep)

    rows = [
        # (label, expert_val, vrp_val, lower_is_better, fmt)
        ("Bus count          (fewer = cheaper)", expert.bus_count, vrp.bus_count, True, "{:.0f}"),
        ("Avg fill %         (higher = efficient)", expert.avg_util_pct, vrp.avg_util_pct, False, "{:.1f}"),
        ("Std fill %         (lower = balanced)", expert.std_util_pct, vrp.std_util_pct, True, "{:.1f}"),
        ("Max overload       (must be ≤ 1.00)", expert.worst_overload, vrp.worst_overload, True, "{:.2f}"),
        ("Avg compactness km (lower = tighter)", expert.avg_compactness_km, vrp.avg_compactness_km, True, "{:.1f}"),
        ("Avg detour ratio   (lower = less waste)", expert.avg_detour, vrp.avg_detour, True, "{:.2f}"),
        ("Total distance km  (lower = less driving)", expert.total_dist_km, vrp.total_dist_km, True, "{:.0f}"),
    ]

    for label, e_val, v_val, lower_better, fmt in rows:
        e_str = fmt.format(e_val)
        v_str = fmt.format(v_val)
        e_mark, v_mark = _winner(e_val, v_val, lower_better)
        print(f"{label:<{W}}  {e_str + e_mark:>{N+2}}  {v_str + v_mark:>{N+2}}")

    print(sep)
    print("  * = better value for that metric")
    print()


def _explain_metrics():
    print("""
Metric guide:
  Bus count          Fewer buses means lower transport cost.
  Avg fill %         How full buses are on average (higher = more efficient use).
  Std fill %         How evenly loads are distributed (lower = more balanced).
  Max overload       Load / capacity for the busiest bus (must be ≤ 1.00 = no over-capacity).
  Avg compactness km Average pairwise distance among schools on the same bus.
                     Lower means schools on the same bus are geographically closer together.
  Avg detour ratio   (Chain distance from first school → ... → destination)
                     divided by (direct distance first school → destination).
                     1.0 = no detour; 1.5 = 50% longer than going direct.
                     Lower means buses take more direct routes.
  Total distance km  Sum of all bus route lengths. Lower = less total driving.

Note: these metrics use straight-line (haversine) distances. Real road
distances in Trentino are ~1.5× longer due to mountain terrain, but the
relative comparison between Expert and VRP remains meaningful.
""")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DATASETS = [
    {
        "dir": TESTS_DIR / "real1",
        "label": "real1 — 20 schools, 263 pax, cap=56",
        "capacity": 56,
    },
    {
        "dir": TESTS_DIR / "real2",
        "label": "real2 — 36 schools, 728 pax, cap=55",
        "capacity": 55,
    },
]


def main():
    _explain_metrics()

    for ds in DATASETS:
        dataset_dir = ds["dir"]
        capacity = ds["capacity"]
        label = ds["label"]

        print(f"Loading {label}...")
        schools, coords, time_matrix = load_dataset(dataset_dir)

        # Parse expert plan
        expert_plan = parse_expert_xlsx(
            dataset_dir / "output.xlsx",
            coords=coords,
            capacity=capacity,
            dest_lat=TRENTO_LAT,
            dest_lon=TRENTO_LON,
            format_version=dataset_dir.name,
        )

        # Run VRP planner
        print(f"  Running VRP solver (~20 s)...")
        t0 = time.time()
        vrp_plan = run_vrp(schools, capacity, time_matrix=time_matrix)
        elapsed = time.time() - t0
        print(f"  VRP done in {elapsed:.0f}s — {vrp_plan.routes.__len__()} buses used")

        # Compute and print metrics
        expert_metrics = compute_metrics(expert_plan)
        vrp_metrics = compute_metrics(vrp_plan)
        print_comparison(label, expert_metrics, vrp_metrics)
        print_similarity(expert_plan, vrp_plan)


if __name__ == "__main__":
    main()
