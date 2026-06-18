
import pandas as pd
import re

class DataLoader:
    REQUIRED_COLUMNS = ['Nome', 'Indirizzo', 'Partecipanti']

    @staticmethod
    def load_data(filepath):
        """
        Loads school data from an Excel file.
        Returns a list of dictionaries with keys: 'id', 'name', 'address', 'demand', 'institute'.
        """
        try:
            df = pd.read_excel(filepath)
            
            # Normalize column names
            df.columns = [str(c).strip() for c in df.columns]
            
            # Column aliases mapping
            aliases = {
                'Indirizzi': 'Indirizzo',
                'Indirizzo di ritiro': 'Indirizzo',
                'Nome Scuola': 'Nome',
                'Istituto Scolastico': 'Nome',
                'Passeggeri': 'Partecipanti',
                'Num Partecipanti': 'Partecipanti',
                'Istituzione': 'Istituto'
            }
            
            # Apply aliases
            rename_map = {}
            for col in df.columns:
                for alias, target in aliases.items():
                    if col.lower() == alias.lower() or col.lower().startswith(alias.lower()):
                        rename_map[col] = target
            df.rename(columns=rename_map, inplace=True)
            
            # Try to handle common misspellings or spaces by checking lowercase
            lower_cols = {c.lower(): c for c in df.columns}
            if 'indirizzo' not in lower_cols and 'indirizzi' in lower_cols:
                df.rename(columns={lower_cols['indirizzi']: 'Indirizzo'}, inplace=True)

            # Check for missing columns
            missing = [col for col in DataLoader.REQUIRED_COLUMNS if col not in df.columns]
            if missing:
                raise ValueError(f"Missing required columns: {', '.join(missing)} (Trovate: {', '.join(df.columns)})")
            
            # Clean and format data
            schools = []
            errors = []
            for index, row in df.iterrows():
                try:
                    # Skip rows where Nome is missing/NaN completely empty
                    if pd.isna(row['Nome']) or str(row['Nome']).strip().lower() == 'nan' or not str(row['Nome']).strip():
                        # Se è una riga vuota, interrompiamo la lettura della tabella
                        if pd.isna(row.get('Indirizzo')) and pd.isna(row.get('Partecipanti')):
                            break
                        else:
                            errors.append({'row': index + 2, 'reason': 'Nome mancante'})
                            continue
                        
                    raw_demand = row['Partecipanti']
                    demand = 0
                    if pd.notna(raw_demand):
                        # Try to parse string demand carefully
                        if isinstance(raw_demand, str):
                            # Extract just the digits
                            digits = re.sub(r'\D', '', raw_demand)
                            if digits:
                                demand = int(digits)
                            else:
                                errors.append({'row': index + 2, 'reason': 'Numero partecipanti non valido'})
                                continue
                        else:
                            demand = int(float(raw_demand))
                            
                    schools.append({
                        'id': index,
                        'name': str(row['Nome']).strip(),
                        'address': str(row['Indirizzo']).strip() if pd.notna(row['Indirizzo']) else '',
                        'original_address': str(row['Indirizzo']).strip() if pd.notna(row['Indirizzo']) else '',
                        'display_address': str(row['Indirizzo']).strip() if pd.notna(row['Indirizzo']) else '',
                        'demand': demand,
                        'institute': str(row['Istituto']).strip() if 'Istituto' in row and pd.notna(row['Istituto']) else None,
                        'is_autonomous': bool(re.search(r'\b(autonomo|autonomi|autonomia|per conto loro|mezzi propri|con genitori|in proprio)\b', str(row['Nome']) + ' ' + (str(row['Indirizzo']) if pd.notna(row['Indirizzo']) else ''), re.IGNORECASE))
                    })
                except Exception as row_e:
                    errors.append({'row': index + 2, 'reason': f'Errore di parsing: {str(row_e)}'})
                    continue
            
            return {'schools': schools, 'errors': errors}
        except Exception as e:
            raise Exception(f"Error loading data: {str(e)}")
