#!/bin/bash

# Transporter - Script di avvio
# Avvia backend e frontend in un colpo solo

echo "🚌 Avvio Transporter..."

# Colori per output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Termina processi precedenti se esistono
echo "📦 Chiudo eventuali processi precedenti..."
pkill -f "python3 app.py" 2>/dev/null
pkill -f "vite" 2>/dev/null

# Avvia il backend Flask
echo -e "${GREEN}🔧 Avvio Backend Flask (porta 5001)...${NC}"
cd "$(dirname "$0")"

# Attiva virtual environment se esiste
if [ -d "venv" ]; then
    echo "🐍 Attivazione virtual environment..."
    source venv/bin/activate
elif [ -d ".venv" ]; then
    echo "🐍 Attivazione virtual environment..."
    source .venv/bin/activate
fi

python3 app.py &
BACKEND_PID=$!

# Aspetta un secondo per far partire il backend
sleep 2

# Avvia il frontend
echo -e "${BLUE}🎨 Avvio Frontend Vite (porta 5173)...${NC}"
cd frontend
npm run dev &
FRONTEND_PID=$!

# Aspetta che il frontend sia pronto
sleep 3

echo ""
echo "============================================"
echo -e "${GREEN}✅ Transporter avviato con successo!${NC}"
echo "============================================"
echo ""
echo "🌐 Frontend: http://localhost:5173"
echo "🔧 Backend:  http://localhost:5001"
echo ""
echo "Premi Ctrl+C per fermare tutto"
echo ""

# Gestisci l'interruzione (Ctrl+C)
trap "echo ''; echo '🛑 Arresto...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM

# Mantieni lo script in esecuzione
wait
