
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

class VRPSolver:
    def __init__(self, distance_matrix, demands, vehicle_capacity, num_vehicles, depot_index=0, fixed_vehicle_cost=0, search_strategy='PATH_CHEAPEST_ARC', starts=None, ends=None):
        self.distance_matrix = distance_matrix
        self.demands = demands
        self.vehicle_capacity = vehicle_capacity
        self.num_vehicles = num_vehicles
        self.depot_index = depot_index
        self.fixed_vehicle_cost = fixed_vehicle_cost
        self.search_strategy = search_strategy
        self.starts = starts
        self.ends = ends
        
    def solve(self):
        """
        Solves the Vehicle Routing Problem.
        Returns a dictionary with routes and metrics.
        """
        if self.starts and self.ends:
            manager = pywrapcp.RoutingIndexManager(
                len(self.distance_matrix),
                self.num_vehicles,
                self.starts,
                self.ends
            )
        else:
            manager = pywrapcp.RoutingIndexManager(
                len(self.distance_matrix),
                self.num_vehicles,
                self.depot_index
            )

        # Create Routing Model.
        routing = pywrapcp.RoutingModel(manager)

        # 1. Distance Callback
        def distance_callback(from_index, to_index):
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return self.distance_matrix[from_node][to_node]

        transit_callback_index = routing.RegisterTransitCallback(distance_callback)
        transit_callback_index = routing.RegisterTransitCallback(distance_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
        
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

        # Setting first solution heuristic.
        search_parameters = pywrapcp.DefaultRoutingSearchParameters()
        
        if self.search_strategy == 'SAVINGS':
            search_parameters.first_solution_strategy = (
                routing_enums_pb2.FirstSolutionStrategy.SAVINGS)
        elif self.search_strategy == 'AUTOMATIC':
             search_parameters.first_solution_strategy = (
                routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC)
        else:
            search_parameters.first_solution_strategy = (
                routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)
        
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
                
                # Get Cost (includes fixed)
                # route_distance += routing.GetArcCostForVehicle(previous_index, index, vehicle_id)
                # Parse pure distance manually to avoid Fixed Cost inclusion
                from_node = manager.IndexToNode(previous_index)
                to_node = manager.IndexToNode(index)
                route_distance += self.distance_matrix[from_node][to_node]
            
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
