import pandas as pd
import numpy as np
df = pd.read_excel("Modulo trasporti Badminton Cadetti_e 27 Feb 2026_bus plan.xlsx")
# simulate frontend or something?
print("Total partecipanti from file:", df['Partecipanti'].sum())
