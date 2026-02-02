
import pandas as pd

try:
    df = pd.read_excel('template.xlsx')
    print("Columns:", df.columns.tolist())
    print(df[['Nome', 'Partecipanti']].to_string())
    print("\nMax Demand:", df['Partecipanti'].max())
except Exception as e:
    print(e)
