
import pandas as pd

try:
    df = pd.read_excel('esempioReale.xlsx')
    print("Columns:", df.columns.tolist())
    print("\nFirst 10 rows (Nome, Indirizzo):")
    print(df[['Nome', 'Indirizzo']].head(10))
    
    # Check for Grigno and Rovereto specifically
    print("\nReference to Grigno/Rovereto:")
    print(df[df['Indirizzo'].str.contains('Grigno|Rovereto', case=False, na=False)][['Nome', 'Indirizzo']])
except Exception as e:
    print(f"Error reading file: {e}")
