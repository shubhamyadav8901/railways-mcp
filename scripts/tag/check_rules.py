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


CHECKS = [check_km_via_heading, check_split_table_cell]

if __name__ == "__main__":
    for c in CHECKS:
        c()
        print(f"ok  {c.__name__}")
