#!/bin/bash

# BusPlan Compare - Script di avvio
# Pre-calcola i dati di confronto e avvia l'interfaccia web

echo "🔍 Avvio BusPlan Compare..."

# Colori per output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

cd "$(dirname "$0")"

# Attiva virtual environment se esiste
if [ -d "venv" ]; then
    source venv/bin/activate
elif [ -d ".venv" ]; then
    source .venv/bin/activate
fi

# Ricalcola i dati solo se richiesto o se mancano
if [ "$1" == "--refresh" ] || [ ! -f "tools/compare/data/index.json" ]; then
    echo -e "${YELLOW}⚙️  Pre-calcolo dati di confronto...${NC}"
    python3 tools/run_compare.py
    if [ $? -ne 0 ]; then
        echo "❌ Errore durante il pre-calcolo. Controlla i fixture in tests/realSuite/."
        exit 1
    fi
    echo ""
else
    echo -e "${YELLOW}💾 Dati già presenti. Usa --refresh per ricalcolare.${NC}"
fi

# Avvia il server HTTP
PORT=${2:-8080}
echo -e "${GREEN}🌐 Avvio server su porta ${PORT}...${NC}"
cd tools/compare
python3 -m http.server "$PORT" &
SERVER_PID=$!

sleep 1

echo ""
echo "============================================"
echo -e "${GREEN}✅ BusPlan Compare avviato!${NC}"
echo "============================================"
echo ""
echo -e "🌐 UI:  ${BLUE}http://localhost:${PORT}${NC}"
echo ""
echo "Opzioni:"
echo "  ./start_compare.sh           → usa dati esistenti"
echo "  ./start_compare.sh --refresh → ricalcola tutti gli eventi"
echo "  ./start_compare.sh --refresh 9090 → porta personalizzata"
echo ""
echo "Premi Ctrl+C per fermare"
echo ""

# Gestisci l'interruzione (Ctrl+C)
trap "echo ''; echo '🛑 Arresto...'; kill $SERVER_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
