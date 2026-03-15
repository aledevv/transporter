import pandas as pd
import sys

df = pd.read_excel('esempioTest.xlsx')
print(df.head(20).to_string())
