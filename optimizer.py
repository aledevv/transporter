
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

class VRPSolver:
    def __init__(self, time_matrix, demands, vehicle_capacity, num_vehicles, depot_index=0, fixed_vehicle_cost=0, starts=None, ends=None, institutes=None):
        self.time_matrix = time_matrix
        self.demands = demands
        self.vehicle_capacity = vehicle_capacity
        self.num_vehicles = num_vehicles
        self.depot_index = depot_index
        self.fixed_vehicle_cost = fixed_vehicle_cost
        self.starts = starts
        self.ends = ends
        self.institutes = institutes

    def solve(self):
        """
        Solves the Vehicle Routing Problem.
        Returns a dictionary with routes and metrics.
        """
        if self.starts and self.ends:
            manager = pywrapcp.RoutingIndexManager(
                len(self.time_matrix),
                self.num_vehicles,
                self.starts,
                self.ends
            )
        else:
            manager = pywrapcp.RoutingIndexManager(
                len(self.time_matrix),
                self.num_vehicles,
                self.depot_index
            )

        # Create Routing Model.
        routing = pywrapcp.RoutingModel(manager)

        # 1. Time Callback with Institute Tracking
        def time_callback(from_index, to_index):
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return self.time_matrix[from_node][to_node]

        transit_callback_index = routing.RegisterTransitCallback(time_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

        # 2. Institute Dimension - tracks institute "changes" as cumulative cost
        def institute_cost_callback(from_index):
            from_node = manager.IndexToNode(from_index)
            if self.institutes and from_node != 0:  # Not depot
                inst = self.institutes[from_node]
                if inst != 'UNIVERSAL':
                    return ord(inst[0]) if inst else 0
            return 0

        institute_callback_index = routing.RegisterUnaryTransitCallback(institute_cost_callback)

        routing.AddDimension(
            institute_callback_index,
            0,  # no slack
            1000000,  # large max
            True,  # start cumul to zero
            'InstituteTracker'
        )

        # Arc-level costs: penalize mixing institutes, bonus for same institute
        def arc_cost_callback(from_index, to_index):
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)

            base_time = self.time_matrix[from_node][to_node]

            if not self.institutes:
                return base_time

            inst_from = self.institutes[from_node]
            inst_to = self.institutes[to_node]

            # SOFT CONSTRAINT: Bonus for keeping same institute together (~10 min)
            if (inst_from != 'UNIVERSAL' and inst_to != 'UNIVERSAL' and
                inst_from == inst_to and from_node != to_node):
                return base_time - 600

            # Penalità moderata (es. 10 min) per il cambio di istituto
            # Questo fa sì che il solver preferisca unire istituti se il risparmio 
            # geografico o il costo del bus (1 ora) giustifica il mix,
            # senza vietarlo in modo assoluto.
            if (inst_from != 'UNIVERSAL' and inst_to != 'UNIVERSAL' and
                inst_from != inst_to):
                return base_time + 600

            return base_time

        arc_callback_index = routing.RegisterTransitCallback(arc_cost_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(arc_callback_index)

        # Add Fixed Cost per Vehicle to prioritize minimizing fleet size
        if self.fixed_vehicle_cost > 0:
            routing.SetFixedCostOfAllVehicles(self.fixed_vehicle_cost)

        # 2. Capacity Constraints
        def demand_callback(from_index):
            from_node = manager.IndexToNode(from_index)
            return self.demands[from_node]

        demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
        routing.AddDimensionWithVehicleCapacity(
            demand_callback_index,
            0,  # null capacity slack
            [self.vehicle_capacity] * self.num_vehicles,  # vehicle maximum capacities
            True,  # start cumul to zero
            'Capacity'
        )

        # Always use SAVINGS heuristic (minimizes buses first, then optimizes)
        search_parameters = pywrapcp.DefaultRoutingSearchParameters()
        search_parameters.first_solution_strategy = (
            routing_enums_pb2.FirstSolutionStrategy.SAVINGS)

        # Local search improvement phase
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH)
        search_parameters.time_limit.seconds = 20
        search_parameters.log_search = False

        # Solve the problem.
        solution = routing.SolveWithParameters(search_parameters)

        # Format result
        if solution:
            return self._format_solution(manager, routing, solution)
        else:
            return None

    def _format_solution(self, manager, routing, solution):
        routes = []
        total_distance = 0
        total_load = 0

        for vehicle_id in range(self.num_vehicles):
            index = routing.Start(vehicle_id)
            route_nodes = []
            route_distance = 0
            route_load = 0

            while not routing.IsEnd(index):
                node_index = manager.IndexToNode(index)
                route_load += self.demands[node_index]
                route_nodes.append({
                    "node": node_index,
                    "load": self.demands[node_index]
                })

                previous_index = index
                index = solution.Value(routing.NextVar(index))

                from_node = manager.IndexToNode(previous_index)
                to_node = manager.IndexToNode(index)
                route_distance += self.time_matrix[from_node][to_node]

            # Add end node (depot)
            node_index = manager.IndexToNode(index)
            route_nodes.append({
                "node": node_index,
                "load": 0
            })

            if len(route_nodes) > 2: # Only include used buses (Start -> ... -> End)
                routes.append({
                    "vehicle_id": vehicle_id,
                    "stops": route_nodes,
                    "distance": route_distance,
                    "load": route_load
                })
                total_distance += route_distance
                total_load += route_load

        return {
            "routes": routes,
            "total_distance": total_distance,
            "total_load": total_load,
            "used_vehicles": len(routes)
        }
