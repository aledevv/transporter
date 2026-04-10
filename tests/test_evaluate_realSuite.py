"""Unit tests for the realSuite scoring functions."""
import pytest
from evaluate_realSuite import score_assignment, score_bus_count, combined_score


# --- score_assignment ---

def test_perfect_assignment():
    pred = {"0": {"A", "B"}, "1": {"C", "D"}}
    gt   = {"fin1": {"A", "B"}, "fin2": {"C", "D"}}
    assert score_assignment(pred, gt) == pytest.approx(1.0)


def test_zero_assignment():
    pred = {"0": {"A", "B"}}
    gt   = {"fin1": {"C", "D"}}
    # intersection=0, union=4 → Jaccard=0
    assert score_assignment(pred, gt) == pytest.approx(0.0)


def test_partial_assignment():
    pred = {"0": {"A", "B", "C"}}
    gt   = {"fin1": {"A", "B"}}
    # Best match: intersection=2, union=3 → Jaccard=2/3
    assert score_assignment(pred, gt) == pytest.approx(2 / 3, abs=0.01)


def test_assignment_handles_unequal_bus_counts():
    # More pred buses than gt buses
    pred = {"0": {"A"}, "1": {"B"}, "2": {"C"}}
    gt   = {"fin1": {"A", "B", "C"}}
    # Best match: one singleton vs {A,B,C} → Jaccard=1/3; mean over 1 matched pair
    result = score_assignment(pred, gt)
    assert result == pytest.approx(1 / 3, abs=0.01)


# --- score_bus_count ---

def test_exact_bus_count():
    assert score_bus_count({"0": {"A"}, "1": {"B"}}, {"f1": {"A"}, "f2": {"B"}}) == pytest.approx(1.0)


def test_one_extra_bus():
    pred = {"0": {"X"}, "1": {"Y"}, "2": {"Z"}}  # 3 buses (all non-empty)
    gt   = {"f1": {"X"}, "f2": {"Y"}}              # 2 buses
    # |3-2|/2 = 0.5 → score = 0.5
    assert score_bus_count(pred, gt) == pytest.approx(0.5)


def test_bus_count_clipped_at_zero():
    pred = {"0": {"A"}, "1": {"B"}, "2": {"C"}, "3": {"D"}, "4": {"E"}}  # 5 buses
    gt   = {"f1": {"A"}, "f2": {"B"}}  # 2 buses
    # |5-2|/2 = 1.5 → clipped to 0
    assert score_bus_count(pred, gt) == pytest.approx(0.0)


# --- combined_score ---

def test_combined_score_perfect():
    buses = {"0": {"A", "B"}}
    assert combined_score(buses, buses) == pytest.approx(1.0)


def test_combined_score_weighted():
    pred = {"0": {"A", "B"}, "1": {"C"}}
    gt   = {"f1": {"A", "B"}, "f2": {"C"}}
    # Perfect assignment (1.0) + perfect count (1.0) → 1.0
    assert combined_score(pred, gt) == pytest.approx(1.0)


def test_combined_score_partial():
    pred = {"0": {"A", "B"}, "1": {"D"}}
    gt   = {"f1": {"A", "B", "C"}}
    assign = 2 / 3       # best Jaccard for pred[0] vs gt[f1] (inter=2, union=3)
    count  = max(0.0, 1.0 - abs(2 - 1) / 1)  # = 0.0 (2 pred vs 1 gt → penalty = 1.0)
    expected = 0.6 * assign + 0.4 * count
    assert combined_score(pred, gt) == pytest.approx(expected, abs=0.01)


def test_empty_buses_ignored_in_count():
    """Empty buses (no schools) should not count toward bus count."""
    pred = {"0": {"A"}, "1": set(), "2": set()}  # 1 non-empty bus
    gt   = {"f1": {"A"}}                           # 1 bus
    assert score_bus_count(pred, gt) == pytest.approx(1.0)
