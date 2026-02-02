
import pandas as pd

data = {
    'Nome': ['Scuola Elementare "Collodi"', 'Scuola Media "Manzoni"', 'Liceo "Da Vinci"'],
    'Indirizzo': ['Via G. Galilei, 1, Trento', 'Corso 3 Novembre, 10, Trento', 'Via A. Diaz, 5, Trento'],
    'Partecipanti': [25, 30, 28]
}

df = pd.DataFrame(data)
df.to_excel('simple_test.xlsx', index=False)
print("Created simple_test.xlsx")
print(df)
