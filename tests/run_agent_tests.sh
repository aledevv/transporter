#!/usr/bin/env bash
# run_agent_tests.sh
# Runs all tests related to the AI address-correction agent and geocoding tool.
#
# Usage:
#   ./tests/run_agent_tests.sh          # from project root
#   cd tests && ./run_agent_tests.sh    # from tests/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Activate virtualenv if present and not already active
if [ -z "${VIRTUAL_ENV:-}" ] && [ -f "$PROJECT_ROOT/venv/bin/activate" ]; then
    source "$PROJECT_ROOT/venv/bin/activate"
fi

echo "=== Agent & Geocoding Tests ==="
echo "Project root: $PROJECT_ROOT"
echo ""

python -m pytest \
    tests/test_address_corrector.py \
    tests/test_geocoding_tool.py \
    tests/test_real_data_corrector.py \
    -v "$@"
