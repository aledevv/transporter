import pdfplumber
import pandas as pd
import re
import os
import warnings

# Ignora avvisi non critici di pandas per un output più pulito
warnings.filterwarnings('ignore')

def elabora_singolo_pdf(pdf_path, output_dir="output_excel"):
    """
    Legge un singolo PDF, estrae le informazioni del viaggio e genera i due file Excel.
    """
    print(f"Inizio elaborazione di: {pdf_path}")
    
    # 1. Variabili per le informazioni generali
    destinazione_generale = "Destinazione non trovata"
    
    # 2. Estrazione Testo Generale e Tabelle
    dati_tabella = []
    
    with pdfplumber.open(pdf_path) as pdf:
        # Estraiamo il testo dalla prima pagina per trovare la destinazione
        testo_prima_pagina = pdf.pages[0].extract_text()
        
        # Usiamo una Regex (Espressione Regolare) per trovare la stringa dopo "DESTINAZIONE:"
        match_destinazione = re.search(r"DESTINAZIONE:\s*(.*)", testo_prima_pagina)
        if match_destinazione:
            destinazione_generale = match_destinazione.group(1).strip()
            
        # Estraiamo le tabelle da tutte le pagine
        for page in pdf.pages:
            tabelle = page.extract_tables()
            for tabella in tabelle:
                # Estendiamo la nostra lista con le righe della tabella
                dati_tabella.extend(tabella)
                
    # 3. Creazione del DataFrame Pandas
    # Se il PDF è strutturato bene, la prima riga sarà l'intestazione
    df = pd.DataFrame(dati_tabella[1:], columns=dati_tabella[0])
    
    # Rinominiamo le colonne per comodità nel codice
    df.columns = ["Bus", "Km", "Istituto", "Partenza", "Indirizzo", "Partecipanti", "Rientro"]
    
    # 4. Data Cleaning (Pulizia dei dati)
    # Rimuoviamo le righe vuote o le righe di riepilogo "TOTALE PAX"
    df = df.dropna(how='all')
    df = df[~df['Bus'].astype(str).str.contains('TOTALE PAX', na=False, case=False)]
    df = df[~df['Istituto'].astype(str).str.contains('TOTALE PAX', na=False, case=False)]
    
    # Sostituiamo le stringhe vuote con NaN (Not a Number) per poter usare ffill()
    df.replace("", pd.NA, inplace=True)
    df.replace(r"^\s*$", pd.NA, regex=True, inplace=True)
    
    # Propaghiamo in basso i valori del Bus e dei Km (es. "Fin 1" scende finché non trova "Fin 2")
    df['Bus'] = df['Bus'].fillna(method='ffill')
    df['Km'] = df['Km'].fillna(method='ffill')
    
    # Anche l'Istituto va propagato se è vuoto ma ci sono indirizzi sotto (scuole con più sedi)
    df['Istituto'] = df['Istituto'].fillna(method='ffill')
    
    # Eliminiamo le righe in cui manca l'indirizzo e la partenza (righe sporche)
    df = df.dropna(subset=['Indirizzo', 'Partenza'])
    
    # 5. Gestione delle celle multilinea (es. IC VALLE DEI LAGHI che ha due ritrovi nella stessa cella)
    def splitta_valori(x):
        # Se la cella è una stringa e contiene il carattere "a capo" (\n), crea una lista
        if isinstance(x, str) and '\n' in x:
            return [val.strip() for val in x.split('\n') if val.strip()]
        # Altrimenti la mette in una lista singola per uniformità
        return [x] if pd.notna(x) else [x]

    # Applichiamo la funzione alle colonne critiche
    colonne_da_esplodere = ['Partenza', 'Indirizzo', 'Partecipanti', 'Rientro']
    for col in colonne_da_esplodere:
        df[col] = df[col].apply(splitta_valori)
        
    # Esplodiamo le liste trasformandole in righe vere e proprie
    df = df.explode(colonne_da_esplodere)
    
    # 6. Costruzione dei due File di Output (Task 1 e Task 2)
    
    # TASK 1: Input.xlsx (Nome, Indirizzo, Partecipanti, Istituto)
    # Rinominiamo logicamente: Il "Nome" specifico in questo caso lo deriviamo.
    df_task1 = pd.DataFrame({
        'Nome': df['Istituto'], # Come da tua regola, se ci sono più indirizzi è sempre l'Istituto
        'Indirizzo': df['Indirizzo'],
        'Partecipanti': df['Partecipanti'],
        'Istituto': df['Istituto']
    })
    
    # TASK 2: Output.xlsx (Bus Plan dettagliato)
    df_task2 = pd.DataFrame({
        'Bus / Codice': df['Bus'],
        'Ditta / Km': df['Km'],
        'Nome Scuola': df['Istituto'],
        'Indirizzo': df['Indirizzo'],
        'Orario Partenza': df['Partenza'],
        'Rientro Presunto': df['Rientro'],
        'Partecipanti': df['Partecipanti'],
        'Destinazione': destinazione_generale
    })
    
    # 7. Salvataggio in Excel
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    nome_base = os.path.splitext(os.path.basename(pdf_path))[0]
    
    file_task1 = os.path.join(output_dir, f"{nome_base}_input.xlsx")
    file_task2 = os.path.join(output_dir, f"{nome_base}_output.xlsx")
    
    df_task1.to_excel(file_task1, index=False)
    df_task2.to_excel(file_task2, index=False)
    
    print(f"Fatto! File salvati in: {output_dir}\n")

def elabora_batch(cartella_pdf):
    """
    Esegue lo script su tutti i file PDF presenti in una cartella.
    Perfetto per i tuoi test futuri!
    """
    for nome_file in os.listdir(cartella_pdf):
        if nome_file.lower().endswith(".pdf"):
            percorso_completo = os.path.join(cartella_pdf, nome_file)
            elabora_singolo_pdf(percorso_completo)

# --- COME UTILIZZARE LO SCRIPT ---
if __name__ == "__main__":
    # Sostituisci questo percorso con il file che stai testando ora
    pdf_di_test = "Piano Viaggi_Palla Tamburello_22 aprile 2026.pdf" 
    
    # Se il file esiste, esegui lo script singolo
    if os.path.exists(pdf_di_test):
        elabora_singolo_pdf(pdf_di_test)
    else:
        print(f"Assicurati che il file '{pdf_di_test}' sia nella stessa cartella dello script.")
        
    # ESEMPIO BATCH (Da usare in futuro decommentando la riga sotto):
    # elabora_batch("./cartella_con_i_miei_pdf")