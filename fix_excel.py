
import pandas as pd

try:
    df = pd.read_excel('template.xlsx')
    print("Original Columns:", df.columns.tolist())
    
    # Rename columns to match requirements
    # 'Nome Scuola' -> 'Nome'
    if 'Nome Scuola' in df.columns:
        df = df.rename(columns={'Nome Scuola': 'Nome'})
        print("Renamed 'Nome Scuola' to 'Nome'")
        
    # Save back to same file
    df.to_excel('template.xlsx', index=False)
    print("File saved successfully.")
    print("New Columns:", df.columns.tolist())
    
except Exception as e:
    print(f"Error fixing excel: {e}")
