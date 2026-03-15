
from optimizer import VRPSolver

def test_strategies():
    print("Optimization Strategy Verification")
    print("----------------------------------")
    
    # Scenario:
    # A and B are close to Depot but far from each other.
    # Using 1 bus requires traversing the gap A->B.
    # Using 2 buses avoids the gap A->B.
    
    # Nodes: 0: Depot, 1: A, 2: B
    # Demands: 1: 25, 2: 25. Total 50. Cap 50.
    demands = [0, 25, 25]
    capacity = 53
    
    # Distance Matrix
    # 0->1: 10
    # 0->2: 10
    # 1->2: 80 (High cost to connect)
    matrix = [
        [0, 10, 10],  # 0
        [10, 0, 80],  # 1
        [10, 80, 0]   # 2
    ]
    
    print("\nTest Case: Two remote clusters")
    print("Distance Matrix:")
    for row in matrix: print(row)
    print("Demands:", demands, "Capacity:", capacity)
    
    # 1. Test Distance Strategy (Fixed Cost = 0)
    print("\n--- Testing Strategy: Shortest Path (Cost=0) ---")
    solver_dist = VRPSolver(matrix, demands, capacity, num_vehicles=5, fixed_vehicle_cost=0)
    sol_dist = solver_dist.solve()
    
    if sol_dist:
        print(f"Used Vehicles: {sol_dist['used_vehicles']}")
        print(f"Total Distance: {sol_dist['total_distance']}")
        for r in sol_dist['routes']:
            print(f"  Bus {r['vehicle_id']}: {[s['node'] for s in r['stops']]}, Dist: {r['distance']}")
            
    # 2. Test Vehicles Strategy (Fixed Cost = 1000)
    print("\n--- Testing Strategy: Min Buses (Cost=1000) ---")
    solver_bus = VRPSolver(matrix, demands, capacity, num_vehicles=5, fixed_vehicle_cost=1000)
    sol_bus = solver_bus.solve()
    
    if sol_bus:
        print(f"Used Vehicles: {sol_bus['used_vehicles']}")
        print(f"Total Distance: {sol_bus['total_distance']}")
        for r in sol_bus['routes']:
            print(f"  Bus {r['vehicle_id']}: {[s['node'] for s in r['stops']]}, Dist: {r['distance']}")

    # Verification
    # Expect Dist: 2 Vehicles, Total Dist 40 (0-1-0 + 0-2-0)
    # Expect Bus: 1 Vehicle, Total Dist 100 (0-1-2-0 or 0-2-1-0)
    
    assert sol_dist['used_vehicles'] == 2, "Distance strategy failed to maximize buses for shorter path"
    assert sol_bus['used_vehicles'] == 1, "Vehicle strategy failed to minimize buses"
    print("\n✅ Verification SUCCESS: Strategies produce distinct results as expected.")

if __name__ == "__main__":
    test_strategies()
