"""
ImprovedVRPSolver — V1-improved OR-Tools solver.

Three improvements over the baseline VRPSolver:
1. Distance-based arc cost (instead of time-based) — minimises km, not minutes.
2. Soft time windows — penalises assigning a nearby school to a far-away bus
   (student waits much longer than a direct trip would require).
3. Fixed vehicle cost calibrated by grid search.

Interface mirrors the existing VRPSolver in optimizer.py so that grid_search.py
can swap them in and out without changing the evaluation harness.
"""
from __future__ import annotations

import math

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# Maximum allowed cumulative time on a vehicle route (24 hours in seconds).
MAX_TIME_SECONDS = 24 * 3600


def _parse_time_str(time_str: str) -> int:
    """Parse 'HH:MM' → seconds since midnight."""
    h, m = map(int, time_str.strip()[:5].split(":"))
    return h * 3600 + m * 60


class ImprovedVRPSolver:
    """
    VRP solver with three improvements over the baseline:
      1. Arc cost = distance (minimises km, not minutes).
      2. Soft lower-bound time windows penalise early pickups.
      3. Calibrated fixed vehicle cost.

    Constructor parameters (all are sweep-able):
        bus_capacity        default vehicle capacity (overridden by solve() arg)
        fixed_vehicle_cost  penalty for opening a new vehicle (distance units)
        slack_minutes       tolerance before soft-window penalty kicks in
        penalty_per_minute  penalty rate (distance units per minute over slack)
        time_limit_seconds  OR-Tools wall-clock time limit per solve call
    """

    def __init__(
        self,
        bus_capacity: int = 54,
        fixed_vehicle_cost: int = 600,
        slack_minutes: int = 20,
        penalty_per_minute: int = 1000,
        time_limit_seconds: int = 30,
    ) -> None:
        self.bus_capacity = bus_capacity
        self.fixed_vehicle_cost = fixed_vehicle_cost
        self.slack_minutes = slack_minutes
        self.penalty_per_minute = penalty_per_minute
        self.time_limit_seconds = time_limit_seconds

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def solve(
        self,
        time_matrix: list[list[int]],
        distance_matrix: list[list[int]],
        demands: list[int],
        num_vehicles: int,
        starts: list[int],
        ends: list[int],
        arrival_time_str: str = "12:00",
        bus_capacity: int | None = None,
    ) -> dict | None:
        """
        Solve the VRP and return a route dict identical in shape to VRPSolver.solve().

        Parameters
        ----------
        time_matrix       (N+2)×(N+2) travel-time matrix in seconds.
                          Index 0 = destination, 1..n = schools, n+1 = dummy start.
        distance_matrix   same shape as time_matrix but in distance units (km or m).
        demands           length-(N+2) list; 0 for destination and dummy.
        num_vehicles      number of vehicle routes to allocate.
        starts            list of start-node indices for each vehicle (dummy = n+1).
        ends              list of end-node indices for each vehicle (destination = 0).
        arrival_time_str  'HH:MM' target arrival time at destination.
        bus_capacity      overrides constructor default when provided.
        """
        capacity = bus_capacity if bus_capacity is not None else self.bus_capacity
        n_nodes = len(time_matrix)
        dest_idx = ends[0]  # always 0 (destination)
        arrival_sec = _parse_time_str(arrival_time_str)

        # ---- routing manager & model --------------------------------
        manager = pywrapcp.RoutingIndexManager(n_nodes, num_vehicles, starts, ends)
        routing = pywrapcp.RoutingModel(manager)

        # ---- 1. Arc cost = distance ---------------------------------
        def distance_callback(from_index, to_index):
            return distance_matrix[manager.IndexToNode(from_index)][
                manager.IndexToNode(to_index)
            ]

        dist_cb_idx = routing.RegisterTransitCallback(distance_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(dist_cb_idx)

        # ---- 2. Time dimension (needed for soft windows + departure calc) ---
        def time_callback(from_index, to_index):
            return time_matrix[manager.IndexToNode(from_index)][
                manager.IndexToNode(to_index)
            ]

        time_cb_idx = routing.RegisterTransitCallback(time_callback)
        routing.AddDimension(
            time_cb_idx,
            0,               # no slack on cumul
            MAX_TIME_SECONDS,
            False,           # do NOT force start cumul to zero (vehicles start at diff times)
            "Time",
        )
        time_dim = routing.GetDimensionOrDie("Time")

        # Hard upper bound at destination: dest_idx is the END node, so we must
        # use routing.End(v) — manager.NodeToIndex(dest_idx) returns -1 for end nodes.
        for v in range(num_vehicles):
            time_dim.CumulVar(routing.End(v)).SetMax(arrival_sec)

        # Soft lower bound per school: penalise picking up too early.
        # school nodes (1..n) are intermediate nodes with valid routing indices.
        slack_sec = self.slack_minutes * 60
        penalty_per_sec = self.penalty_per_minute / 60  # convert to per-second

        n_schools = len(demands) - 2  # total nodes minus dest and dummy
        for school_node in range(1, n_schools + 1):
            # Ideal departure = latest time the bus could leave this school
            # and still arrive on time (if this school were the last stop).
            ideal_dep = arrival_sec - time_matrix[school_node][dest_idx]
            soft_lb = max(0, ideal_dep - slack_sec)
            node_ri = manager.NodeToIndex(school_node)
            time_dim.SetCumulVarSoftLowerBound(
                node_ri, int(soft_lb), int(penalty_per_sec)
            )

        # ---- 3. Fixed vehicle cost ----------------------------------
        if self.fixed_vehicle_cost > 0:
            routing.SetFixedCostOfAllVehicles(self.fixed_vehicle_cost)

        # ---- 4. Capacity constraint --------------------------------
        def demand_callback(from_index):
            return demands[manager.IndexToNode(from_index)]

        demand_cb_idx = routing.RegisterUnaryTransitCallback(demand_callback)
        routing.AddDimensionWithVehicleCapacity(
            demand_cb_idx,
            0,
            [capacity] * num_vehicles,
            True,
            "Capacity",
        )

        # ---- 5. Search parameters ----------------------------------
        search_params = pywrapcp.DefaultRoutingSearchParameters()
        search_params.first_solution_strategy = (
            routing_enums_pb2.FirstSolutionStrategy.SAVINGS
        )
        search_params.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
        search_params.time_limit.seconds = self.time_limit_seconds
        search_params.log_search = False

        solution = routing.SolveWithParameters(search_params)
        if solution is None:
            return None

        return self._format_solution(manager, routing, solution, time_matrix, demands, num_vehicles)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _format_solution(
        self,
        manager: pywrapcp.RoutingIndexManager,
        routing: pywrapcp.RoutingModel,
        solution,
        time_matrix: list[list[int]],
        demands: list[int],
        num_vehicles: int,
    ) -> dict:
        routes = []
        total_distance = 0
        total_load = 0

        for vehicle_id in range(num_vehicles):
            index = routing.Start(vehicle_id)
            route_nodes: list[dict] = []
            route_distance = 0
            route_load = 0

            while not routing.IsEnd(index):
                node = manager.IndexToNode(index)
                route_load += demands[node]
                route_nodes.append({"node": node, "load": demands[node]})

                prev_index = index
                index = solution.Value(routing.NextVar(index))

                from_node = manager.IndexToNode(prev_index)
                to_node = manager.IndexToNode(index)
                route_distance += time_matrix[from_node][to_node]

            # append end node (destination)
            node = manager.IndexToNode(index)
            route_nodes.append({"node": node, "load": 0})

            if len(route_nodes) > 2:  # at least one real stop
                routes.append(
                    {
                        "vehicle_id": vehicle_id,
                        "stops": route_nodes,
                        "distance": route_distance,
                        "load": route_load,
                    }
                )
                total_distance += route_distance
                total_load += route_load

        return {
            "routes": routes,
            "total_distance": total_distance,
            "total_load": total_load,
            "used_vehicles": len(routes),
        }
