"""
Entry point for the full test suite.
Run with:  python3 run_tests.py
Or directly with pytest for more options:  pytest tests/ -v
"""
import sys
import pytest


class PauseOnFailPlugin:
    """Pytest plugin: on each test failure, print the full error and ask whether to continue."""

    @pytest.hookimpl(trylast=True)  # run after the terminal reporter has printed its line
    def pytest_runtest_logreport(self, report):
        if not report.failed or report.when not in ("setup", "call"):
            return

        print("\n" + "=" * 70)
        print(f"FALLITO: {report.nodeid}  [{report.when}]")
        print("=" * 70)
        if report.longrepr:
            print(str(report.longrepr))
        print("=" * 70)

        while True:
            try:
                choice = input("\n[c] continua con i prossimi test  [s] stoppa tutto: ").strip().lower()
            except (EOFError, KeyboardInterrupt, OSError):
                # OSError is raised when stdin is captured (e.g. running under pytest -s or system tasks)
                # In that case, just continue automatically
                print()
                return

            if choice in ("s", "stop", "q"):
                pytest.exit("Interrotto dall'utente dopo il fallimento.", returncode=1)
                return
            elif choice in ("c", "continua", ""):
                return
            else:
                print("Digita 'c' per continuare o 's' per stoppare.")


if __name__ == "__main__":
    exit_code = pytest.main(
        ["tests/", "-v", "--tb=no"],  # --tb=no: traceback shown by our plugin, not duplicated
        plugins=[PauseOnFailPlugin()],
    )
    sys.exit(exit_code)
