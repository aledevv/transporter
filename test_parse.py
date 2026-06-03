import pandas as pd
from data_loader import DataLoader

df = pd.read_excel("Modulo trasporti Badminton Cadetti_e 27 Feb 2026_bus plan.xlsx")
df.rename(columns={"Indirizzi": "Indirizzo"}, inplace=True)
df.to_excel("temp.xlsx", index=False)

data = DataLoader.load_data("temp.xlsx")
schools = data["schools"]
for s in schools:
    print(f"School: {s['name']}, Demand: {s['demand']}")

# Let's also test agglomeration
seen = {}
for s in schools:
    seen[s['name']] = seen.get(s['name'], 0) + s['demand']

print("\nAgglomerated:")
for name, d in seen.items():
    print(f"{name}: {d}")
