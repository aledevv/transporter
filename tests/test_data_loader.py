"""Tests for DataLoader."""
import pandas as pd
import pytest

from data_loader import DataLoader


def make_excel(tmp_path, data: dict, filename="test.xlsx") -> str:
    path = tmp_path / filename
    pd.DataFrame(data).to_excel(path, index=False)
    return str(path)


class TestLoadData:
    def test_loads_required_columns(self, tmp_path):
        path = make_excel(tmp_path, {
            "Nome": ["Scuola A"],
            "Indirizzo": ["Via Roma, 1, Trento"],
            "Partecipanti": [10],
        })
        result = DataLoader.load_data(path)
        schools = result["schools"]

        assert len(schools) == 1
        assert schools[0]["name"] == "Scuola A"
        assert schools[0]["address"] == "Via Roma, 1, Trento"
        assert schools[0]["demand"] == 10
        assert schools[0]["institute"] is None

    def test_loads_optional_istituto(self, tmp_path):
        path = make_excel(tmp_path, {
            "Nome": ["Scuola A", "Scuola B"],
            "Indirizzo": ["Via Roma, 1", "Via Dante, 2"],
            "Partecipanti": [10, 5],
            "Istituto": ["IC Trento 1", "IC Trento 1"],
        })
        result = DataLoader.load_data(path)
        schools = result["schools"]

        assert schools[0]["institute"] == "IC Trento 1"
        assert schools[1]["institute"] == "IC Trento 1"

    def test_institute_none_when_column_absent(self, tmp_path):
        path = make_excel(tmp_path, {
            "Nome": ["Scuola A"],
            "Indirizzo": ["Via Roma, 1"],
            "Partecipanti": [10],
        })
        result = DataLoader.load_data(path)
        schools = result["schools"]
        assert schools[0]["institute"] is None

    def test_raises_on_missing_required_column(self, tmp_path):
        path = make_excel(tmp_path, {
            "Nome": ["Scuola A"],
            "Indirizzo": ["Via Roma, 1"],
            # "Partecipanti" intentionally missing
        })
        with pytest.raises(Exception, match="Missing required columns"):
            DataLoader.load_data(path)

    def test_strips_whitespace_from_column_names(self, tmp_path):
        path = make_excel(tmp_path, {
            " Nome ": ["Scuola A"],
            " Indirizzo ": ["Via Roma, 1"],
            " Partecipanti ": [10],
        })
        # Should not raise
        result = DataLoader.load_data(path)
        schools = result["schools"]
        assert len(schools) == 1

    def test_missing_demand_defaults_to_zero(self, tmp_path):
        import numpy as np
        path = make_excel(tmp_path, {
            "Nome": ["Scuola A"],
            "Indirizzo": ["Via Roma, 1"],
            "Partecipanti": [None],
        })
        result = DataLoader.load_data(path)
        schools = result["schools"]
        assert schools[0]["demand"] == 0

    def test_row_id_matches_dataframe_index(self, tmp_path):
        path = make_excel(tmp_path, {
            "Nome": ["A", "B", "C"],
            "Indirizzo": ["Via 1", "Via 2", "Via 3"],
            "Partecipanti": [1, 2, 3],
        })
        result = DataLoader.load_data(path)
        schools = result["schools"]
        assert [s["id"] for s in schools] == [0, 1, 2]
