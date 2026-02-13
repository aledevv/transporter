import pandas as pd

def create_test_excel():
    data = [
        {'Nome': 'Scuola A', 'Indirizzo': 'Via Roma 1, Trento', 'Partecipanti': 15, 'Istituto': 'Istituto Comprensivo 1'},
        {'Nome': 'Scuola B', 'Indirizzo': 'Via Roma 10, Trento', 'Partecipanti': 15, 'Istituto': 'Istituto Comprensivo 1'},
        {'Nome': 'Scuola C', 'Indirizzo': 'Via Milano 1, Trento', 'Partecipanti': 15, 'Istituto': 'Istituto Comprensivo 2'},
        {'Nome': 'Scuola D', 'Indirizzo': 'Via Napoli 1, Trento', 'Partecipanti': 55, 'Istituto': 'Istituto Comprensivo 3'}
    ]
    
    df = pd.DataFrame(data)
    df.to_excel('test_institute_mixing.xlsx', index=False)
    print("Created test_institute_mixing.xlsx")

if __name__ == "__main__":
    create_test_excel()
