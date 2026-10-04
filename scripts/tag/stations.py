"""Map TAG station names to station codes.

Source of codes: data/datameet2016.json.gz (stations: [code, name, state, zone, lat, lon])
plus the hand-curated scripts/tag/station_aliases.csv (renamed stations, codes
that changed since 2016, and TAG spellings that differ from datameet).

Only unambiguous matches are returned: an alias, or an exact match of the
normalised name that points at exactly one code. Everything else -> None.
"""
from __future__ import annotations

import csv
import gzip
import json
import pathlib
import re
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATAMEET = ROOT / "data" / "datameet2016.json.gz"
ALIASES = pathlib.Path(__file__).resolve().parent / "station_aliases.csv"
AMBIGUOUS = pathlib.Path(__file__).resolve().parent / "station_ambiguous.csv"

# token rewrites applied after lower-casing and punctuation removal
TOKEN_MAP = {
    "junction": "", "jn": "", "jct": "", "jnc": "",
    "cantonment": "cantt", "cant": "cantt", "cantt": "cantt",
    "rd": "road",
    "terminus": "t", "terminal": "t", "term": "t", "trm": "t",
    "pandit": "pt", "pt": "pt",
    "hazrat": "h",
    "halt": "halt",
    "stn": "", "station": "",
    "nagar": "nagar",
    "bypass": "bypass",
    "mumbai": "mumbai",
}


def light(name: str) -> str:
    """Case/punctuation/whitespace only (used for aliases and the first match pass)."""
    s = name.lower().replace("\u2019", "'")
    s = re.sub(r"[.,'()\-/]", " ", s)
    return " ".join(s.split())


def normalise(name: str) -> str:
    s = name.lower().replace("&", " and ")
    s = s.replace("’", "'").replace("`", "'")
    s = re.sub(r"\(t\)", " t ", s)
    s = re.sub(r"\b(by)\s+(pass)\b", "bypass", s)
    s = re.sub(r"[.,'()\-/]", " ", s)
    toks = [TOKEN_MAP.get(t, t) for t in s.split()]
    return " ".join(t for t in toks if t)


class StationMatcher:
    def __init__(self):
        d = json.load(gzip.open(DATAMEET))
        self.dm = {s[0]: s for s in d["stations"] if not s[0].startswith("XX-")}
        # datameet 2016 routes (all halts): code -> {route index: stop position}; used only to tell
        # which of several same-named stations lies on the line between two coded stops
        self.route_pos: dict[str, dict[int, int]] = defaultdict(dict)
        for k, t in enumerate(d.get("trains", [])):
            for i, st in enumerate(t["stops"]):
                self.route_pos[st[0]].setdefault(k, i)
        self.by_norm: dict[str, set[str]] = defaultdict(set)
        self.by_light: dict[str, set[str]] = defaultdict(set)
        self.by_nospace: dict[str, set[str]] = defaultdict(set)
        for code, s in self.dm.items():
            self.by_norm[normalise(s[1])].add(code)
            self.by_light[light(s[1])].add(code)
            self.by_nospace[normalise(s[1]).replace(" ", "")].add(code)
        self.alias: dict[str, tuple[str, str | None]] = {}
        self.meta_code: dict[str, str] = {}
        with open(ALIASES, newline="") as f:
            for row in csv.DictReader(r for r in f if not r.startswith("#")):
                code = row["code"].strip()
                dmc = (row.get("datameet_code") or "").strip() or None
                key = light(row["tag_name"])
                if key in self.alias and self.alias[key][0] != code:
                    raise ValueError(f"conflicting aliases for {row['tag_name']!r}")
                self.alias[key] = (code, dmc)
                if dmc:
                    self.meta_code[code] = dmc

        self.ambiguous: dict[str, list[str]] = {}
        with open(AMBIGUOUS, newline="") as f:
            for row in csv.DictReader(r for r in f if not r.startswith("#")):
                codes = row["candidates"].split()
                missing = [c for c in codes if c not in self.dm]
                if missing:
                    raise ValueError(f"station_ambiguous.csv: {missing} not in datameet")
                self.ambiguous[light(row["tag_name"])] = codes

    def candidates(self, name: str) -> list[str]:
        """Codes a name may refer to when match() calls it ambiguous (curated list,
        or several datameet stations with the same normalised name)."""
        ln = light(name)
        if ln in self.ambiguous:
            return list(self.ambiguous[ln])
        if ln in self.alias:
            return []
        c = self.by_light.get(ln, set())
        if len(c) > 1:
            return sorted(c)
        n = normalise(name)
        c = c or self.by_norm.get(n, set()) or self.by_nospace.get(n.replace(" ", ""), set())
        return sorted(c) if len(c) > 1 else []

    def line_support(self, cand: str, prev: str, nxt: str) -> int:
        """Number of datameet 2016 routes that serve cand between prev and nxt (in either direction)."""
        def dmc(c):
            return c if c in self.route_pos else self.meta_code.get(c, c)
        rp, rn = self.route_pos.get(dmc(prev), {}), self.route_pos.get(dmc(nxt), {})
        n = 0
        for k, i in self.route_pos.get(dmc(cand), {}).items():
            a, b = rp.get(k), rn.get(k)
            n += a is not None and b is not None and (a < i < b or b < i < a)
        return n

    def coords(self, code: str):
        src = self.dm.get(code) or self.dm.get(self.meta_code.get(code, ""))
        if src and src[4] is not None and src[5] is not None:
            return (src[4], src[5])
        return None

    def match(self, name: str) -> tuple[str | None, str]:
        """Return (code|None, how). how in alias|exact|code|ambiguous|none."""
        ln = light(name)
        if ln in self.ambiguous:
            return None, "ambiguous"
        if ln in self.alias:
            return self.alias[ln][0], "alias"
        cands = self.by_light.get(ln, set())
        if len(cands) == 1:
            return next(iter(cands)), "exact"
        n = normalise(name)
        cands = cands or self.by_norm.get(n, set()) or self.by_nospace.get(n.replace(" ", ""), set())
        if len(cands) == 1:
            return next(iter(cands)), "exact"
        if len(cands) > 1:
            return None, "ambiguous"
        # a cell note may print a bare station code ("DLI 09.50 10.05")
        if re.fullmatch(r"[A-Z]{2,5}", name.strip()) and name.strip() in self.dm:
            return name.strip(), "code"
        return None, "none"

    def zone(self, code: str):
        src = self.dm.get(code) or self.dm.get(self.meta_code.get(code, ""))
        return src[3] if src else None

    def station_tuple(self, code: str, tag_name: str):
        src = self.dm.get(code) or self.dm.get(self.meta_code.get(code, ""))
        if not src:
            return [code, tag_name, None, None, None, None]
        return [code, tag_name, src[2], src[3], src[4], src[5]]
