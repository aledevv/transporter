#!/bin/bash
set -e

# Esegui i test prima del deploy — se uno fallisce il deploy viene bloccato
echo "🧪 Esecuzione test suite prima del deploy..."
./venv/bin/python3 run_tests.py
echo "✅ Tutti i test passati. Procedo con il deploy."

# Incrementa versione
python3 bump_version.py

# ---------------------------------------------------------------------------
# Leggi variabili d'ambiente dal file .env locale (NON committato su git).
# Le righe vuote e i commenti (# ...) vengono ignorati.
# ---------------------------------------------------------------------------
ENV_FLAG=""
if [ -f .env ]; then
    ENV_VARS=$(grep -v '^\s*#' .env | grep -v '^\s*$' | tr '\n' ',' | sed 's/,$//')
    if [ -n "$ENV_VARS" ]; then
        ENV_FLAG="--set-env-vars=$ENV_VARS"
        echo "📦 Variabili d'ambiente caricate da .env"
    fi
else
    echo "⚠️  Nessun file .env trovato — le variabili d'ambiente NON verranno aggiornate su Cloud Run."
    echo "   Crea un file .env con GOOGLE_API_KEY, GOOGLE_API_KEY2, GOOGLE_API_KEY3 prima del deploy."
fi

echo "🚀 Deploy su Cloud Run (progetto bus-plan-6d002)..."
gcloud run deploy transporter \
  --source . \
  --platform managed \
  --region europe-west6 \
  --allow-unauthenticated \
  --project bus-plan-6d002 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 3 \
  --no-cpu-throttling \
  $ENV_FLAG

firebase deploy --only hosting:busplan
