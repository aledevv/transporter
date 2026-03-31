#!/bin/bash
# Run the full test suite and print a summary.
# Usage: ./run_tests.sh [extra pytest args, e.g. -k real1]

set -e

VENV_PYTHON="./venv/bin/python3"

if [ ! -f "$VENV_PYTHON" ]; then
    echo "ERROR: venv not found. Run: python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
    exit 1
fi

echo "Running test suite..."
echo ""

# Run pytest; always capture exit code even if tests fail (we show summary first)
set +e
$VENV_PYTHON -m pytest tests/ -v --tb=short "$@"
EXIT_CODE=$?
set -e

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "Result: ALL TESTS PASSED"
else
    echo "Result: SOME TESTS FAILED (exit code $EXIT_CODE)"
fi

exit $EXIT_CODE
