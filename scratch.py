from data_loader import DataLoader
import sys

res = DataLoader.load_data("Modulo trasporti Badminton Cadetti_e 27 Feb 2026_bus plan.xlsx")
print(f"Schools loaded: {len(res['schools'])}")
print(f"Errors: {len(res['errors'])}")
