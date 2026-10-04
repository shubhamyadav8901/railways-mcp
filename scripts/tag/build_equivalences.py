"""Build data/station_equivalences.json: station codes that denote the same physical
station (renamed / recoded stations, duplicate codes in the datameet 2016 list).

    python3 scripts/tag/build_equivalences.py --erail-cache DIR --ct-cache DIR

Candidates
  * route: a TAG stop whose code is absent from the same train's eRail route, while
    eRail has, at the same position (between the same matched neighbours), exactly one
    stop absent from TAG with identical arrival/departure times.
  * datameet: two codes within 1 km in datameet whose normalised names agree.
Evidence (ConfirmTkt station autosuggest is the second coordinate source; QA sources
are only used here to *relate* codes - the timetable itself is not changed)
  * coord: the retired code's datameet position is within 1 km of the live code's
    ConfirmTkt position.
  * dm-coord: datameet places both codes within 1 km (only counted with matching names).
  * route: the route match above (listing the trains).
  * retired: a datameet code not in TAG within 1 km of a TAG station (proposal only), a datameet
    train terminal found by ConfirmTkt name search, or a datameet-2016 vs eRail stop at the same
    position (terminal or single-stop slot) of the same train number ("route-dm").
    Evidence: (a) datameet vs ConfirmTkt coordinates within 1 km, (b) exact normalised name match
    (Jn/Junction, CST/CSMT, Terminus/(T) ... allowed), route-dm. Accepted with (a) plus (b) or
    route-dm. Names that only contain each other never count (listed as doubtful).
Rejection rules
  * positions more than 5 km apart (any pair), or > 1 km for retired pairs;
  * both codes live on ConfirmTkt (distinct neighbours such as Dadar DR/DDR, Sabarmati SBI/SBT),
    EXCEPT for retired pairs with route-dm evidence AND (ConfirmTkt gives both codes the same name
    OR route-dm from >= 2 train pairs): ConfirmTkt still lists some legacy codes (BCT, CSTM, MUV);
  * ConfirmTkt lookups that fail, exceed the 150-call budget, or return a full (truncated) list
    without the code count as no evidence.
Other accepted combinations: coord + TAG-vs-eRail route, coord + dm-coord. TAG-vs-eRail route
evidence counts once per pair, and not at all when the TAG code came from station_aliases.csv.
Coordinates come only from datameet's own entries and ConfirmTkt.
`current` = the code ConfirmTkt lists as live (else the eRail code).
"""
from __future__ import annotations
import os


def _env(name):
    """Operator-supplied setting (see .env.example); needed only for new ConfirmTkt lookups."""
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"{name} is not set (see .env.example); it is needed for new ConfirmTkt lookups")
    return v

import argparse
import datetime as dt
import gzip
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse
import uuid
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from stations import StationMatcher, normalise  # noqa: E402

OUT = ROOT / "data" / "station_equivalences.json"
CT_URL = ("https://cttrainsapi.confirmtkt.com/api/v2/trains/stations/auto-suggestion?searchString={q}"
          "&sourceStnCode=&popularStnListLimit=15&preferredStnListLimit=6&channel=mwebd&language=EN")


def km(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


ABBREV = [  # applied to normalise()d, space-free names
    (r"chhatrapatishivajimaharajterminus|chhatrapatishivajiterminus|cstm|csmt|cst", "csmt"),
    (r"lokmanyatilakterminus|lokmanyatilakt|ltt", "ltt"),
    (r"terminus|terminal|term", "t"),
    (r"junction|jn|jct", ""),
    (r"cantonment|cantt|cant", "cantt"),
    (r"road|rd", "road"),
]


def name_key(n: str) -> str:
    k = normalise(n).replace(" ", "")
    for rx, rep in ABBREV:
        k = re.sub(rx, rep, k)
    return k


def names_match(a: str, b: str) -> str | None:
    """'exact' when the normalised names agree (allowing the abbreviations above),
    'contains' when one contains the other (>= 5 chars; reported as doubtful), else None."""
    ka, kb = name_key(a), name_key(b)
    if not ka or not kb:
        return None
    if ka == kb:
        return "exact"
    short, long_ = sorted((ka, kb), key=len)
    if len(short) >= 5 and short in long_:
        return "contains"
    return None


def et(t):
    m = re.fullmatch(r"(\d\d)[.:](\d\d)", t or "")
    return f"{m.group(1)}:{m.group(2)}" if m else None


def erail_route(cache: pathlib.Path, n: str):
    f = cache / f"route_{n}.txt"
    if not f.exists():
        return None
    out = []
    for r in f.read_text().split("^")[1:]:
        x = r.split("~")
        if len(x) >= 8 and x[0].isdigit():
            out.append({"code": x[1], "name": x[2], "arr": et(x[3]), "dep": et(x[4])})
    return out or None


class CT:
    def __init__(self, cache: pathlib.Path):
        self.cache = cache
        cache.mkdir(parents=True, exist_ok=True)
        self.last = 0.0
        self.dev = str(uuid.uuid4())
        self.new_calls, self.max_new = 0, 150
        self.failed, self.skipped = [], []
        self.names: dict[str, str] = {}   # code -> datameet name, for the not-live check

    def _fetch(self, q: str, f: pathlib.Path, limit: int = 15):
        if not f.exists():
            if self.new_calls >= self.max_new:
                self.skipped.append(q)
                return None
            self.new_calls += 1
            for attempt in range(2):
                wait = (2.05 if attempt == 0 else 15.0) - (time.time() - self.last)
                if wait > 0:
                    time.sleep(wait)
                try:
                    r = subprocess.run(["curl", "-sS", "--connect-timeout", "15", "--max-time", "30",
                                        CT_URL.format(q=urllib.parse.quote(q)).replace("popularStnListLimit=15", f"popularStnListLimit={limit}"),
                                        "-H", f"clientid: {_env('CONFIRMTKT_CLIENT_ID')}", "-H", f"apikey: {_env('CONFIRMTKT_API_KEY')}", "-H", f"deviceid: {self.dev}"],
                                       capture_output=True, text=True, timeout=60)
                except subprocess.TimeoutExpired:
                    r = subprocess.CompletedProcess([], 28, "", "timeout")
                self.last = time.time()
                if r.returncode == 0 and r.stdout.startswith("{"):
                    break
            if r.returncode != 0 or not r.stdout.startswith("{"):
                self.failed.append(q)  # skipped: the candidate lacks evidence and is rejected
                return None
            f.write_text(r.stdout)
        return json.loads(f.read_text())

    def search(self, name: str):
        """Autosuggest by station name -> [{code, name, pos}]."""
        key = re.sub(r"[^A-Za-z0-9]+", "_", name.strip()).strip("_")[:60]
        d = self._fetch(name, self.cache / f"ctname_{key}.json")
        out = []
        if d is None:
            return out
        for s in (d.get("data") or {}).get("stationList") or []:
            try:
                pos = (float(s["latitude"]), float(s["longitude"]))
            except (TypeError, ValueError, KeyError):
                pos = None
            out.append({"code": s.get("stationCode"), "name": s.get("stationName"), "pos": pos})
        return out

    def lookup(self, code: str):
        f = self.cache / f"ct_{code}.json"
        d = self._fetch(code, f)
        if d is None:
            return "unknown"
        lst = (d.get("data") or {}).get("stationList") or []
        if len(lst) >= 15 and not any(x.get("stationCode") == code for x in lst):
            # the autosuggest list is cut at 15 rows, so absence proves nothing. Search by the
            # station's datameet name: if the code is still absent from a list that is NOT full,
            # it is not live; otherwise its status is unknown (no evidence).
            if not self.names or code not in self.names:
                return "unknown"
            hits = self.search(self.names[code])
            if any(h["code"] == code for h in hits):
                lst = [{"stationCode": h["code"], "stationName": h["name"],
                        "latitude": h["pos"][0] if h["pos"] else None,
                        "longitude": h["pos"][1] if h["pos"] else None} for h in hits]
            elif len(hits) >= 15 or not hits:
                return "unknown"
            else:
                return None
        for s in lst:
            if s.get("stationCode") == code:
                try:
                    return {"name": s.get("stationName"), "pos": (float(s["latitude"]), float(s["longitude"]))}
                except (TypeError, ValueError, KeyError):
                    return {"name": s.get("stationName"), "pos": None}
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--erail-cache", required=True)
    ap.add_argument("--ct-cache", required=True)
    a = ap.parse_args()
    er_cache, ct = pathlib.Path(a.erail_cache), CT(pathlib.Path(a.ct_cache))
    m = StationMatcher()
    ct.names = {c: st[1] for c, st in m.dm.items()}
    tag = json.load(gzip.open(ROOT / "data" / "tag2026.json.gz"))
    tag_names = defaultdict(set)
    for s in tag["stations"]:
        tag_names[s[0]].add(s[1])

    def dm_pos(code):
        # datameet's own entry only (no fallback through station_aliases.csv meta codes,
        # which would make the coordinate evidence depend on our own alias table)
        s = m.dm.get(code)
        return (s[4], s[5]) if s and s[4] is not None and s[5] is not None else None

    # ---- route candidates
    route_ev = defaultdict(set)          # (tagcode, erailcode) -> {train}
    route_alias = defaultdict(set)       # pairs whose TAG code came from station_aliases.csv
    erail_names = {}
    for t in tag["trains"]:
        e = erail_route(er_cache, t["n"])
        if not e:
            continue
        for s in e:
            erail_names.setdefault(s["code"], s["name"])
        E = {s["code"]: i for i, s in enumerate(e)}
        T = {s[0] for s in t["stops"] if s[0]}
        stops = t["stops"]
        for k, s in enumerate(stops):
            x = s[0]
            if not x or x in E:
                continue
            lo = max((E[p[0]] for p in stops[:k] if p[0] in E), default=-1)
            hi = min((E[p[0]] for p in stops[k + 1:] if p[0] in E), default=len(e))
            cand = []
            for j in range(lo + 1, hi):
                y = e[j]
                if y["code"] in T:
                    continue
                checks = [(s[2], y["arr"]), (s[3], y["dep"])]
                checks = [(o, v) for o, v in checks if o is not None]
                if checks and all(o == v for o, v in checks):
                    cand.append(y["code"])
            if len(cand) == 1:
                route_ev[(x, cand[0])].add(t["n"])
                if m.match(s[1])[1] == "alias":
                    route_alias[(x, cand[0])].add(s[1])
    # ---- datameet near-duplicates among codes we care about
    care = set(tag_names) | set(erail_names)
    dm_pairs = set()
    pts = [(c, dm_pos(c)) for c in care if c in m.dm and dm_pos(c)]
    grid = defaultdict(list)
    for c, p in pts:
        grid[(round(p[0], 1), round(p[1], 1))].append((c, p))
    allpts = [(c, p) for c, p in ((c, dm_pos(c)) for c in m.dm) if p]
    for c, p in allpts:
        for d0 in (-0.1, 0, 0.1):
            for d1 in (-0.1, 0, 0.1):
                for c2, p2 in grid.get((round(p[0] + d0, 1), round(p[1] + d1, 1)), []):
                    if c2 != c and km(p, p2) <= 1.0:
                        n1 = normalise(m.dm[c][1]).replace(" ", "")
                        n2 = normalise(m.dm[c2][1]).replace(" ", "")
                        if n1 == n2:
                            dm_pairs.add(tuple(sorted((c, c2))))
    pairs = {tuple(sorted(p)) for p in route_ev} | dm_pairs
    # ---- retired datameet codes: not in TAG, close to a TAG station or a terminal of a datameet train
    tag_codes = set(tag_names)
    retired = {}                          # (old, new) -> how proposed
    tag_pts = [(c, m.coords(c)) for c in tag_codes if m.coords(c)]   # proposal only; evidence uses ConfirmTkt
    for c, s0 in m.dm.items():
        p0 = dm_pos(c)
        if c in tag_codes or not p0:
            continue
        for tc, tp in tag_pts:
            if tc != c and abs(tp[0] - p0[0]) < 0.02 and abs(tp[1] - p0[1]) < 0.02 and km(tp, p0) <= 1.0:
                retired[(c, tc)] = "within 1 km of TAG station"
    dmt = json.load(gzip.open(ROOT / "data" / "datameet2016.json.gz"))["trains"]
    terms = sorted({c for tr in dmt for c in (tr["stops"][0][0], tr["stops"][-1][0])
                    if c and c in m.dm and c not in tag_codes and dm_pos(c)} - {o for o, _ in retired})
    n_search = 0
    for c in terms:
        if ct.lookup(c):          # live: not retired
            continue
        n_search += 1
        for hit in ct.search(m.dm[c][1]):
            if hit["code"] and hit["code"] != c and hit["pos"] and km(hit["pos"], dm_pos(c)) <= 1.0:
                retired[(c, hit["code"])] = "ConfirmTkt name search for a datameet terminal"
    # datameet (2016) vs eRail (current) route of the same train number: a datameet stop
    # missing from eRail whose slot (between the same matched neighbours) holds exactly one
    # eRail stop missing from datameet. Independent of TAG and of our alias table.
    route_dm = defaultdict(set)
    for tr in dmt:
        e = erail_route(er_cache, tr["n"])
        if not e:
            continue
        dcodes = [s0[0] for s0 in tr["stops"] if s0[0]]
        E = {s0["code"]: i for i, s0 in enumerate(e)}
        D = {c: i for i, c in enumerate(dcodes)}
        # terminals: the same train number's origin / destination
        if dcodes and dcodes[0] not in E and e[0]["code"] not in D:
            route_dm[(dcodes[0], e[0]["code"])].add(tr["n"])
        if dcodes and dcodes[-1] not in E and e[-1]["code"] not in D:
            route_dm[(dcodes[-1], e[-1]["code"])].add(tr["n"])
        for k, x in enumerate(dcodes):
            if x in E:
                continue
            pk = next((j for j in range(k - 1, -1, -1) if dcodes[j] in E), None)
            nk = next((j for j in range(k + 1, len(dcodes)) if dcodes[j] in E), None)
            lo_ = E[dcodes[pk]] if pk is not None else -1
            hi_ = E[dcodes[nk]] if nk is not None else len(e)
            dslot = (nk if nk is not None else len(dcodes)) - (pk if pk is not None else -1) - 1
            eslot = [y for y in e[lo_ + 1:hi_] if y["code"] not in D]
            if dslot == 1 and hi_ - lo_ - 1 == 1 and len(eslot) == 1:
                route_dm[(x, eslot[0]["code"])].add(tr["n"])
    for (x, y), ns in route_dm.items():
        if x in m.dm and dm_pos(x):
            retired.setdefault((x, y), "datameet-vs-eRail route of the same train")
    print(f"retired-code candidates: {len(retired)} (searched {n_search} datameet terminals by name; "
          f"{len(route_dm)} datameet-vs-eRail route pairs)", file=sys.stderr)
    retired_accept, retired_reject, doubtful = [], [], []
    for (old, new), how in sorted(retired.items()):
        lo, ln = ct.lookup(old), ct.lookup(new)
        if "unknown" in (lo, ln):
            retired_reject.append(((old, new), "ConfirmTkt status unknown (lookup failed, truncated result list, or budget exhausted); no evidence"))
            continue
        if not ln or not ln["pos"]:
            retired_reject.append(((old, new), f"{new} not found on ConfirmTkt"))
            continue
        d = km(dm_pos(old), ln["pos"])
        if d > 1.0:
            retired_reject.append(((old, new), f"datameet {old} is {d:.1f} km from ConfirmTkt {new}"))
            continue
        rd = sorted(route_dm.get((old, new), set()))
        nm = names_match(m.dm[old][1], ln["name"])
        ev = [f"coord: datameet {old} {dm_pos(old)[0]:.4f},{dm_pos(old)[1]:.4f} vs ConfirmTkt {new} "
              f"{ln['pos'][0]:.4f},{ln['pos'][1]:.4f} ({d * 1000:.0f} m)"]
        if nm == "exact":
            ev.append(f"name: datameet '{m.dm[old][1]}' vs ConfirmTkt '{ln['name']}'")
        if rd:
            ev.append(f"route: datameet 2016 lists {old} and eRail lists {new} at the same position (terminal or single-stop slot) of train(s) {', '.join(rd)}")
        if lo:
            # ConfirmTkt keeps some legacy codes (BCT, CSTM, MGS ...) as entries, but also lists
            # distinct neighbouring stations (Dadar DR/DDR): only route evidence separates them
            if not rd:
                retired_reject.append(((old, new), f"old code is live on ConfirmTkt ('{lo['name']}') and no route evidence"))
                continue
            # both codes are live: guard against a train re-terminated between two distinct
            # nearby stations (e.g. Lucknow LJN/LKO). Require ConfirmTkt to give both codes the
            # same name, or route evidence from >= 2 different train pairs (up/down counted once).
            pairs_n = {(int(n) - 1) // 2 for n in rd if n.isdigit()}
            if names_match(lo["name"], ln["name"]) != "exact" and len(pairs_n) < 2:
                retired_reject.append(((old, new), f"both codes live on ConfirmTkt with different names ('{lo['name']}' / '{ln['name']}') "
                                       f"and route evidence from only {len(pairs_n)} train pair(s) ({', '.join(rd)})"))
                doubtful.append((old, new, ev + [f"both live, names differ, route evidence only {', '.join(rd)} - rejected"]))
                continue
            ev.append(f"{old} still listed by ConfirmTkt as '{lo['name']}' (legacy entry)")
        else:
            ev.append(f"{old} not listed by ConfirmTkt")
        if not (nm == "exact" or rd):
            retired_reject.append(((old, new), f"names differ (datameet '{m.dm[old][1]}' vs ConfirmTkt '{ln['name']}') and no route evidence"
                                   + (" [names contain each other]" if nm == "contains" else "")))
            if nm == "contains":
                doubtful.append((old, new, ev + [f"name only contained: '{m.dm[old][1]}' / '{ln['name']}' - rejected"]))
            continue
        ev.append(f"proposed by: {how}")
        retired_accept.append((old, new, ev))
    print(f"candidate pairs: {len(pairs)} (route {len(route_ev)}, datameet {len(dm_pairs)})", file=sys.stderr)
    # ---- ConfirmTkt
    live = {}
    for c in sorted({c for p in pairs for c in p}):
        live[c] = ct.lookup(c)
    groups_edges = []
    rejected = []
    for p in sorted(pairs):
        x, y = p
        ev = []
        trains = route_ev.get((x, y), set()) | route_ev.get((y, x), set())
        via_alias = route_alias.get((x, y), set()) | route_alias.get((y, x), set())
        route = bool(trains) and not via_alias
        if trains:
            ev.append(f"route: same position and identical times in TAG vs eRail for train(s) {', '.join(sorted(trains))}"
                      + (f" - NOT counted: the TAG code comes from our own alias for {sorted(via_alias)}" if via_alias else ""))
        lx, ly = live.get(x), live.get(y)
        if "unknown" in (lx, ly):
            rejected.append((p, "ConfirmTkt status unknown (lookup failed, truncated result list, or budget exhausted); no evidence"))
            continue
        if lx and ly:
            rejected.append((p, "both codes are live stations on ConfirmTkt"))
            continue
        cur = x if lx else y if ly else None
        old = y if cur == x else x if cur == y else None
        positions = [q for q in (dm_pos(x), dm_pos(y), lx and lx["pos"], ly and ly["pos"]) if q]
        if len(positions) >= 2 and max(km(u, v) for u in positions for v in positions) > 5:
            rejected.append((p, "positions more than 5 km apart"))
            continue
        coord = False
        if cur and old and dm_pos(old) and live[cur]["pos"]:
            d = km(dm_pos(old), live[cur]["pos"])
            if d <= 1.0:
                coord = True
                ev.append(f"coord: datameet {old} {dm_pos(old)[0]:.4f},{dm_pos(old)[1]:.4f} vs ConfirmTkt {cur} "
                          f"{live[cur]['pos'][0]:.4f},{live[cur]['pos'][1]:.4f} ({d * 1000:.0f} m); {old} not listed by ConfirmTkt")
        dmc = False
        if p in dm_pairs:
            dmc = True
            ev.append(f"dm-coord: datameet lists {x} '{m.dm[x][1]}' and {y} '{m.dm[y][1]}' within 1 km")
        # route evidence counts once per pair (all trains share one name->code mapping)
        ok = (coord and route) or (coord and dmc)
        if not ok:
            rejected.append((p, "only one piece of evidence: " + "; ".join(ev) if ev else "no evidence"))
            continue
        if cur is None:  # neither live on ConfirmTkt: take the code eRail uses
            cur = y if (x, y) in route_ev else x if (y, x) in route_ev else None
            if cur is None:
                rejected.append((p, "no current code"))
                continue
        groups_edges.append((x, y, cur, ev))
    for old, new, ev in retired_accept:
        groups_edges.append((old, new, new, ev))
    rejected += retired_reject
    # ---- union into groups
    parent = {}

    def find(c):
        parent.setdefault(c, c)
        while parent[c] != c:
            parent[c] = parent[parent[c]]
            c = parent[c]
        return c
    for x, y, _, _ in groups_edges:
        parent[find(x)] = find(y)
    groups = defaultdict(lambda: {"codes": set(), "current": set(), "evidence": []})
    for x, y, cur, ev in groups_edges:
        g = groups[find(x)]
        g["codes"] |= {x, y}
        g["current"].add(cur)
        g["evidence"] += [f"{x}~{y}: {e}" for e in ev]
    out_groups = []
    for g in groups.values():
        cur = sorted(g["current"])
        if len(cur) != 1:
            rejected.append((tuple(sorted(g["codes"])), f"conflicting current codes {cur}"))
            continue
        names = set()
        for c in g["codes"]:
            names |= tag_names.get(c, set())
            if isinstance(live.get(c), dict):
                names.add(live[c]["name"])
            if c in m.dm:
                names.add(m.dm[c][1])
        out_groups.append({"codes": sorted(g["codes"]), "current": cur[0], "names": sorted(n for n in names if n),
                           "evidence": g["evidence"]})
    out_groups.sort(key=lambda g: g["codes"])
    grouped = {c: i for i, g in enumerate(out_groups) for c in g["codes"]}
    rejected = [(p, why) for p, why in rejected
                if not (all(c in grouped for c in p) and len({grouped[c] for c in p}) == 1)]
    doc = {"meta": {"built_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                    "method": "candidates: TAG-vs-eRail route alignment (same position, identical times), datameet "
                              "near-duplicates, and retired datameet codes (near a TAG station, terminal name search, or "
                              "datameet-2016 vs eRail same-train position). Accepted only with two independent pieces of "
                              "evidence among: datameet-vs-ConfirmTkt coordinates within 1 km, exact normalised names, route "
                              "position. Rejected: > 5 km apart; both codes live on ConfirmTkt unless a retired pair has "
                              "datameet-vs-eRail route evidence and either identical ConfirmTkt names or >= 2 train pairs.",
                    "sources": ["data/datameet2016.json.gz", "data/tag2026.json.gz (TAG 2026)",
                                "eRail train routes (cached)", "ConfirmTkt station autosuggest (cached)"]},
           "groups": out_groups}
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out_groups)} groups; {len(rejected)} candidate pairs rejected")
    for g in out_groups:
        print(f"  {'/'.join(g['codes'])} -> {g['current']} {g['names']}")
        for e in g["evidence"]:
            print(f"      {e}")
    print(f"ConfirmTkt: {ct.new_calls} new lookups, {len(ct.failed)} failed, {len(ct.skipped)} skipped over the 150 budget")
    print(f"retired-code pairs: {len(retired)} candidates, {len(retired_accept)} accepted, {len(retired_reject)} rejected")
    print("doubtful candidates (rejected):")
    for old, new, ev in doubtful:
        print(f"  {old}->{new}: " + "; ".join(ev))
    print("rejected:")
    for p, why in rejected:
        print(f"  {'/'.join(p)}: {why}")


if __name__ == "__main__":
    main()
