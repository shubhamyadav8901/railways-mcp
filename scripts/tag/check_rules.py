"""Checks for individual parser/merge rules on small synthetic inputs (no PDFs needed).

    python3 scripts/tag/check_rules.py

Each check builds the smallest input that exercises one rule and asserts the result.
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import parse_pdf  # noqa: E402


def word(text, x0, top, width=None):
    """A pdfplumber-style word; width defaults to 2.5 pt per character (TAG's station-name font)."""
    x1 = x0 + (width if width is not None else 2.5 * len(text))
    return {"text": text, "x0": x0, "x1": x1, "top": top, "bottom": top + 6}


def names(ws):
    return " ".join(w["text"] for w in ws)


def check_km_via_heading():
    head = word("Km.via", 57.2, 174.2, width=15.1)
    # 18.pdf layout: one-word place under the heading, station name beside it on its own line
    row = [head, word("Delhi", 75, 178), word("Barauni", 56, 181, width=17)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "Delhi"
    # two-word place under the heading: both words belong to the heading
    row = [head, word("Guwahati", 75, 178), word("New", 56, 181, width=8), word("Jalpaiguri", 65.4, 181)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "Guwahati"
    # a place printed on two lines under the heading
    row = [head, word("Guwahati", 75, 178), word("New", 56, 181, width=8), word("Jalpaiguri", 56, 187, width=15)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "Guwahati"
    # two-word station name beside the place: its words are not chained to the place (gap > 3 pt)
    row = [head, word("New", 75, 178, width=8), word("Delhi", 84.4, 178), word("Barauni", 56, 181, width=17)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "New Delhi"
    # place on the heading's own line ("Km.via Barauni Guwahati"): only the next word is the place
    row = [head, word("Barauni", 73.5, 174.2), word("Guwahati", 100, 174.2)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "Guwahati"
    # everything under the heading would be the place: nothing left for the station -> next word only
    row = [head, word("Barauni", 56, 181, width=17), word("Delhi", 74.5, 181)]
    assert names(parse_pdf._drop_km_via_heading(row)) == "Delhi"


def check_split_table_cell():
    import build
    split = build.split_table_cell
    # one table for both numbers: applies to each
    assert split("via 25", ["14007", "14017"], {}) == {"14007": "via 25", "14017": "via 25"}
    # 6.pdf "63/22" over 11055/11059: 11055 runs only in table 63, so the printed order is the one fit
    own = {"11055": {6, 63}, "11059": {6, 22, 63}}
    assert split("63/22", ["11055", "11059"], own) == {"11055": "63", "11059": "22"}
    # 29.pdf "66A/74A" over 15630/15930: TAG's order is reversed here (15930 runs in 66, 15630 nowhere
    # else): no assignment fits both, so 15930 gets the one part that fits it and 15630 nothing
    own = {"15630": {29}, "15930": {29, 66}}
    assert split("66A/74A", ["15630", "15930"], own) == {"15630": "", "15930": "66A"}
    # both numbers run in both tables: the order cannot be confirmed -> nothing for either
    own = {"1": {63, 22}, "2": {63, 22}}
    assert split("63/22", ["1", "2"], own) == {"1": "", "2": ""}
    # both numbers fit only the same part: it cannot belong to both -> nothing for either
    own = {"1": {63}, "2": {63}}
    assert split("63/22", ["1", "2"], own) == {"1": "", "2": ""}


def _seg(sid, stops):
    """A minimal build.Seg stand-in: stops = [(code, name, arr, dep, flags, boxed)], times as HH:MM."""
    from types import SimpleNamespace
    import build
    out, prev, rel = [], None, 0
    for i, (code, name, arr, dep, flags, boxed) in enumerate(stops):
        ev = {}
        for kind, t in (("arr", arr), ("dep", dep)):
            if t:
                m = build.mins(t)
                rel += 0 if prev is None else (m - prev) % 1440
                prev = m
                ev[kind] = rel
        out.append({"key": code or "N:" + name, "code": code, "cands": [], "name": name, "arr": arr, "dep": dep,
                    "km": None, "flags": list(flags), "boxed": boxed, "rel": ev, "i": i})
    return SimpleNamespace(sid=sid, stops=out, keys=[s["key"] for s in out], raw={})


def check_same_halt_two_names():
    import build
    # Lucknow (LKO) in one table, Lucknow Jn. (LJN) in another, same arrival and departure: one halt
    # named differently; which station is not certain, so it is omitted (12572, 15706, 22199)
    a = _seg(1, [("CNB", "Kanpur", "00:50", "00:55", (), False), ("LKO", "Lucknow", "02:30", "02:40", (), False),
                 ("GD", "Gonda", "05:00", "05:05", (), False)])
    b = _seg(2, [("LJN", "Lucknow Jn.", "02:30", "02:40", (), False), ("GD", "Gonda", "05:00", "05:05", (), False),
                 ("GKP", "Gorakhpur", "09:15", None, ("single_centered",), True)])
    off = {1: 0, 2: 100}   # b's Lucknow is 100 min after a's Kanpur arrival
    warns = []
    m = build._merge_component([a, b], off, warns)
    assert [x["code"] for x in m] == ["CNB", "GD", "GKP"], [x["code"] for x in m]
    assert build._ordered(m) is None
    assert any("which one the train uses is not certain" in w for w in warns)
    # a third table naming the same halt with yet another code is omitted with it
    c = _seg(3, [("ASH", "Aishbagh", "02:30", "02:40", (), False), ("GD", "Gonda", "05:00", "05:05", (), False)])
    m = build._merge_component([a, b, c], {**off, 3: 100}, [])
    assert [x["code"] for x in m] == ["CNB", "GD", "GKP"], [x["code"] for x in m]
    # two different stations with the same SINGLE time stay unresolved (Satna / Prayagraj): excluded
    a = _seg(1, [("MKP", "Manikpur", "15:20", "15:25", (), False), ("STA", "Satna", None, "18:30", ("single_by_marker",), False)])
    b = _seg(2, [("MKP", "Manikpur", "15:20", "15:25", (), False), ("PRYJ", "Prayagraj", None, "18:30", ("single_centered",), True)])
    m = build._merge_component([a, b], {1: 0, 2: 0}, [])
    assert "undetermined" in build._ordered(m)


def check_same_single_time_explicit_role():
    import build
    # boxed terminal "Udaipur City" a 08.05 in one table, "Udaipur" 08.05 with no clear role in another
    # (19670): one stop, the coded name and the explicit arrival are kept
    a = _seg(1, [("KOTA", "Kota", "01:20", "01:40", (), False), ("UDZ", "Udaipur City", "08:05", None, ("single_a_only",), True)])
    b = _seg(2, [("KOTA", "Kota", "01:20", "01:40", (), False), ("BUDI", "Bundi", None, "02:15", ("single_d_only",), False),
                 (None, "Udaipur", None, "08:05", ("single_centered",), True)])
    m = build._merge_component([a, b], {1: 0, 2: 0}, [])
    assert build._ordered(m) is None
    last = m[-1]
    assert (last["code"], last["arr"][0], last["dep"]) == ("UDZ", "08:05", None)
    assert not (last["flags"] & build.SINGLE_AMBIG)


def check_line_rule_unserved_twin():
    """resolve_ambiguous on the real datameet 2016 data: a candidate no 2016 route serves, at the
    winner's own point, does not block the line choice; two served codes at one point still do."""
    from collections import Counter
    import build
    matcher = build.StationMatcher()

    def resolve(prev, name, nxt):
        merged = [{"code": prev}, {"code": None, "name": name, "cands": matcher.candidates(name)}, {"code": nxt}]
        build.resolve_ambiguous(merged, matcher, [], Counter())
        return merged[1]["code"]
    assert resolve("MSH", "Kalol", "ADI") == "KLL"        # KLLF: 20 m away, on no 2016 route
    assert resolve("GWL", "Dhaulpur", "AGC") == "DHO"     # DHOA: 60 m away, on no 2016 route
    assert resolve("RJT", "Jetalsar", "VRL") == "JLR"     # JLRF: 30 m away, on no 2016 route
    assert resolve("JSM", "Phalodi", "LGH") is None       # PLC/PLCJ: both on 2016 routes at one point
    assert resolve("MSH", "Sabarmati", "ADI") is None     # SBI/SBT: both on the same 2016 routes


CHECKS = [check_km_via_heading, check_split_table_cell, check_same_halt_two_names, check_same_single_time_explicit_role,
          check_line_rule_unserved_twin]

if __name__ == "__main__":
    for c in CHECKS:
        c()
        print(f"ok  {c.__name__}")
