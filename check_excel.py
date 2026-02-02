
import pandas as pd

try:
    df = pd.read_excel('template.xlsx')
    print("Columns:", df.columns.tolist())
    print("First few rows:\n", df.head())
except Exception as e:
    print(f"Error reading excel: {e}")
