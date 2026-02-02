
import unittest
from optimizer import VRPSolver

class TestVRPSolver(unittest.TestCase):
    def test_simple_routing(self):
        # 3 locations: 0 (Depot), 1 (School A), 2 (School B)
        # Distance: 
        # 0-1: 10
        # 0-2: 20
        # 1-2: 5
        matrix = [
            [0, 10, 20],
            [10, 0, 5],
            [20, 5, 0]
        ]
        
        # Demands: Depot=0, A=10, B=10
        demands = [0, 10, 10]
        
        # 1 Vehicle, Capacity 30
        solver = VRPSolver(matrix, demands, 30, 1)
        solution = solver.solve()
        
        print("\nSolution:", solution)
        
        self.assertIsNotNone(solution)
        self.assertEqual(len(solution['routes']), 1)
        self.assertEqual(solution['total_load'], 20)
        
        # Best route should be 0 -> 1 -> 2 -> 0 (Dist 10 + 5 + 20 = 35)
        # Or 0 -> 2 -> 1 -> 0 (Dist 20 + 5 + 10 = 35)
        self.assertEqual(solution['total_distance'], 35)

    def test_capacity_constraint(self):
        # 3 locations, each demand 20. Capacity 30.
        # Needs 2 vehicles.
        matrix = [[0, 10, 10], [10, 0, 10], [10, 10, 0]]
        demands = [0, 20, 20]
        
        solver = VRPSolver(matrix, demands, 30, 2)
        solution = solver.solve()
        
        self.assertIsNotNone(solution)
        self.assertEqual(len(solution['routes']), 2)

if __name__ == '__main__':
    unittest.main()
