
import pandas as pd

class DataLoader:
    REQUIRED_COLUMNS = ['Nome', 'Indirizzo', 'Partecipanti']

    @staticmethod
    def load_data(filepath):
        """
        Loads school data from an Excel file.
        Returns a list of dictionaries with keys: 'id', 'name', 'address', 'demand'.
        """
        try:
            df = pd.read_excel(filepath)
            
            # Normalize column names (strip whitespace, lowercase)
            df.columns = [c.strip() for c in df.columns]
            
            # Check for missing columns
            missing = [col for col in DataLoader.REQUIRED_COLUMNS if col not in df.columns]
            if missing:
                raise ValueError(f"Missing required columns: {', '.join(missing)}")
            
            # Clean and format data
            schools = []
            for index, row in df.iterrows():
                try:
                    schools.append({
                        'id': index,
                        'name': str(row['Nome']),
                        'address': str(row['Indirizzo']),
                        'demand': int(row['Partecipanti']) if pd.notna(row['Partecipanti']) else 0,
                        'institute': str(row['Istituto']) if 'Istituto' in row and pd.notna(row['Istituto']) else None
                    })
                except ValueError:
                    continue # Skip bad rows
            
            return schools
        except Exception as e:
            raise Exception(f"Error loading data: {str(e)}")
