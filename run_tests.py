"""
Entry point for the full test suite.
Run with:  python3 run_tests.py
Or directly with pytest for more options:  pytest tests/ -v
"""
import sys
import pytest

if __name__ == "__main__":
    exit_code = pytest.main([
        "tests/",
        "-v",
        "--tb=short",
    ])
    sys.exit(exit_code)
