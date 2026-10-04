"""Build data/tag2026.json.gz from the TAG 2026 PDFs in data/raw/tag2026/.

    python3 scripts/tag/download.py      # fetch PDFs (once)
    python3 scripts/tag/build.py         # parse + merge + write dataset + report

Per-PDF parse results are cached in data/raw/tag2026/parsed/ (keyed by the
parser source hash), so re-runs after merge-logic changes are fast.
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import os
import pathlib
import re
import sys
from collections import Counter, defaultdict
from multiprocessing import Pool

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RAW = ROOT / "data" / "raw" / "tag2026"
CACHE = RAW / "parsed"
OUT = ROOT / "data" / "tag2026.json.gz"
REPORT = RAW / "build_report.json"
sys.path.insert(0, str(HERE))

import parse_pdf  # noqa: E402
from stations import StationMatcher, normalise  # noqa: E402

DAY_TOK = {"su": "SUN", "sun": "SUN", "m": "MON", "mo": "MON", "mon": "MON", "tu": "TUE", "tue": "TUE",
           "w": "WED", "we": "WED", "wed": "WED", "th": "THU", "thu": "THU", "f": "FRI", "fr": "FRI", "fri": "FRI",
           "sa": "SAT", "sat": "SAT"}
WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
CLASS_RE = re.compile(r"3A\(E\)|3AE|1A|2A|3A|3E|SL|CC|EC|2S|FC|EV|EA|PC|GEN|GS|II|P")
CLASS_MAP = {"1A": "1A", "2A": "2A", "3A": "3A", "3E": "3E", "3A(E)": "3E", "3AE": "3E", "SL": "SL",
             "CC": "CC", "EC": "EC", "2S": "2S", "FC": "FC"}
CLASS_IGNORED = {"II", "P", "PC", "GEN", "GS", "EV", "EA"}   # unreserved / pantry / not in the IRCTC list
TYPE_KEYWORDS = [  # (regex on name, type) - first match wins
    (r"vande\s*bharat", "Vande Bharat"), (r"rajdhani", "Rajdhani"), (r"jan\s*shatabdi", "Jan Shatabdi"),
    (r"shatabdi", "Shatabdi"), (r"duronto", "Duronto"), (r"garib\s*rath", "Garib Rath"),
    (r"humsafar", "Humsafar"), (r"tejas", "Tejas"), (r"gatiman|gatimaan", "Gatimaan"),
    (r"amrit\s*bharat", "Amrit Bharat"), (r"antyodaya", "Antyodaya"), (r"sampark\s*kranti", "Sampark Kranti"),
    (r"double\s*decker", "Double Decker"), (r"\buday\b", "Uday"), (r"namo\s*bharat", "Namo Bharat"),
    (r"\bmemu\b", "MEMU"), (r"\bdemu\b", "DEMU"), (r"passenger", "Passenger"),
    (r"\bmail\b", "Mail"), (r"superfast|\bsf\b", "SF"), (r"express|\bexp\b", "Exp"),
]
MAX_GAP = 12 * 60  # longest plausible time between two consecutive listed stops
SINGLE_AMBIG = {"single_centered", "single_unmarked", "single_role_unknown"}


# ---------------------------------------------------------------- parsing ---
def _parser_hash() -> str:
    h = hashlib.sha1()
    for f in ("parse_pdf.py",):
        h.update((HERE / f).read_bytes())
    return h.hexdigest()[:12]


def _parse_one(args):
    path, cache_file = args
    segs, warns, info = parse_pdf.parse_pdf(str(path))
    data = {"segments": segs, "warnings": warns, "info": info}
    cache_file.write_text(json.dumps(data))
    return path.name, data


def parse_all() -> dict:
    pdfs = sorted(RAW.glob("*.pdf"), key=lambda p: int(p.stem))
    if not pdfs:
        sys.exit("no PDFs in data/raw/tag2026 - run scripts/tag/download.py first")
    ph = _parser_hash()
    cdir = CACHE / ph
    cdir.mkdir(parents=True, exist_ok=True)
    todo, out = [], {}
    for p in pdfs:
        cf = cdir / (p.stem + ".json")
        if cf.exists():
            out[p.name] = json.loads(cf.read_text())
        else:
            todo.append((p, cf))
    if todo:
        with Pool(min(8, os.cpu_count() or 2)) as pool:
            for name, data in pool.imap_unordered(_parse_one, todo):
                out[name] = data
    return {k: out[k] for k in sorted(out, key=lambda n: int(n.split(".")[0]))}


# ------------------------------------------------------------ small utils ---
def mins(t: str) -> int:
    return int(t[:2]) * 60 + int(t[3:])


def parse_days(raw: str):
    s = raw.strip()
    if not s:
        return None, "days not printed"
    s2 = re.sub(r"\s+", " ", s.replace(".", " ").replace(";", ",")).strip()
    if re.fullmatch(r"(?i)daily", s2):
        return list(WEEK), None
    m = re.fullmatch(r"(?i)(?:except|exc|ex)\s+(.+)", s2)
    neg = bool(m)
    body = m.group(1) if m else s2
    toks = [t for t in re.split(r"[,\s&]+", body) if t]
    days = []
    for t in toks:
        d = DAY_TOK.get(t.lower())
        if not d:
            return None, f"unrecognised days {raw!r}"
        days.append(d)
    if neg:
        days = [d for d in WEEK if d not in days]
    return [d for d in WEEK if d in set(days)], None


def parse_classes(raw: str):
    s = re.sub(r"[\s,./;:-]+", "", raw.upper())
    if not s:
        return None, "classes not printed"
    pos, toks = 0, []
    for m in CLASS_RE.finditer(s):
        if m.start() != pos:
            return None, f"unrecognised class text {raw!r}"
        toks.append(m.group(0))
        pos = m.end()
    if pos != len(s):
        return None, f"unrecognised class text {raw!r}"
    out = []
    for t in toks:
        c = CLASS_MAP.get(t)
        if c and c not in out:
            out.append(c)
    order = ["1A", "2A", "3A", "3E", "SL", "FC", "EC", "CC", "2S"]
    return sorted(out, key=order.index), None


def train_type(name: str):
    for rx, t in TYPE_KEYWORDS:
        if re.search(rx, name, re.I):
            return t
    return None


def clean_name(n: str) -> str:
    n = re.sub(r"\s+", " ", n).strip()
    n = re.sub(r"(?<=[a-z])-\s(?=[a-z])", "", n)
    return n


# --------------------------------------------------------- per segment -----
def split_raw(raw: dict) -> list[dict]:
    """Cut one parsed column into pieces that are internally consistent:
    before a boxed departure-only time (the train's run starts there), after a
    boxed arrival-only time (it ends there), and wherever the clock goes
    backwards by less than 4 h (impossible between consecutive listed stops).
    Rows printed above the start / below the end of a run belong to connecting
    information, not to this run's order."""
    # TAG repeats a junction row around a branch (e.g. Khurda Road before and after
    # Puri); a through train shows the same times in both rows -> keep one.
    seen, stops = set(), []
    for st in raw["stops"]:
        k = (normalise(st["name"]), st["arr"], st["dep"])
        if k not in seen:
            seen.add(k)
            stops.append(st)
    raw = {**raw, "stops": stops}
    cuts = set()
    prev = None
    for i, st in enumerate(stops):
        # a boxed single time that is the column's last entry is where the run ENDS
        # (terminal rows often carry a "d" marker), so only cut when the run continues
        if 0 < i < len(stops) - 1 and st["boxed"] and st["dep"] and not st["arr"]:
            cuts.add(i)
        # likewise a boxed single time that is the column's first entry is where the run STARTS
        if 0 < i < len(stops) - 1 and st["boxed"] and st["arr"] and not st["dep"]:
            cuts.add(i + 1)
        for kind in ("arr", "dep"):
            t = st[kind]
            if t is None:
                continue
            m = mins(t)
            if prev is not None and (m - prev[0]) % 1440 > MAX_GAP and prev[1] != i:
                cuts.add(i)
            prev = (m, i)
    if not cuts:
        return [raw]
    pieces, start = [], 0
    for c in sorted(cuts) + [len(stops)]:
        if c > start:
            pieces.append({**raw, "stops": stops[start:c], "piece": len(pieces) + 1})
        start = c
    return pieces


# footnote text that makes a shared column differ between its numbers (halts, route, portions)
SHARED_NOTE_DIFF = re.compile(r"(?i)halt|stop|via|only|extend|terminat|terminal|short|portion|slip|bifurcat|amalgamat|link|attach"
                              r"|cancel|divert|reschedul|change|day")


def split_table_cell(text: str, nums: list[str], own_tables: dict) -> dict:
    """A From/To Table cell of a column headed by several numbers -> {number: cell text}.
    A cell without "/" applies to every number. "63/22" over "11055/11059" names one table per
    number, but TAG's order is not reliable (see split_shared), so each part is matched to a
    number by the tables the number's own columns appear in (own_tables: number -> PDF numbers):
    when exactly one one-to-one assignment fits, it is used; otherwise a number gets the one part
    whose table carries it, or nothing ("") when no part or several parts do."""
    parts = [p.strip() for p in text.split("/")]
    if len(parts) == 1:
        return {n: text for n in nums}

    def fits(n, p):
        return bool(_refs(p)) and _refs(p) <= own_tables.get(n, set())
    if len(parts) == len(nums):
        import itertools
        perms = [pm for pm in itertools.permutations(parts) if all(fits(n, p) for n, p in zip(nums, pm))]
        if len(perms) == 1:
            return dict(zip(nums, perms[0]))
    out = {}
    for n in nums:
        c = [p for p in parts if fits(n, p)]
        out[n] = c[0] if len(c) == 1 else ""
    return out


def split_shared(raw: dict, own_days: dict, own_tables: dict | None = None):
    """A column headed by several numbers ("12888/12896") prints timings that TAG gives for each of
    them, with the running days of each number separated by "/" in the same order ("Su/Th").
    One column per number is returned only when nothing in the column is specific to one number:
    the Days cell splits into exactly one parseable group per number, the times carry no footnote
    marker and no cell note, boxed (start/end) times sit only at the column's first or last stop,
    and every marker on the numbers has a footnote that says nothing about halts or route.
    Otherwise (None, reason).
    The Days row gives the days at the originating station, so a number's own columns in other
    tables (own_days: number -> set of parsed day tuples) must print the same days. The split
    days are used only when all numbers but one are confirmed that way and none is contradicted
    (TAG prints "15630/15930" over "M / F" while 15930's own column says M); otherwise each
    number's days are withheld (null) and only the times are used.
    From/To Table cells are split per number by split_table_cell."""
    shared = raw.get("shared")
    if not shared:
        return None, "number cell not readable"
    n = len(shared)
    days = [d.strip() for d in raw["days_raw"].split("/")]
    if len(days) != n or any(parse_days(d)[0] is None for d in days):
        return None, f"running days {raw['days_raw']!r} do not split into one group per number"
    stops = raw["stops"]
    if any(f.startswith("footnote:") or f == "inset" for st in stops for f in st["flags"]):
        return None, "a time or cell note in the column applies to one of the numbers only"
    if any("cell text" in w or "cell note" in w for w in raw["warnings"]):
        return None, "a cell note in the column applies to one of the numbers only"
    if any(st["boxed"] and 0 < i < len(stops) - 1 for i, st in enumerate(stops)):
        return None, "a boxed start/end time inside the column (one number starts or ends there)"
    names = {normalise(st["name"]) for st in stops}
    for num, marks in shared:
        for mk in filter(None, marks.split(",")):
            note = raw.get("footnotes", {}).get(mk)
            if note is None:
                return None, f"footnote {mk} of {num} not found on the page"
            if SHARED_NOTE_DIFF.search(note) or any(len(x) >= 4 and re.search(rf"\b{re.escape(x)}\b", normalise(note)) for x in names):
                return None, f"footnote {mk} of {num} concerns halts or route: {note!r}"
    arr_days = [d.strip() for d in raw["arr_days_raw"].split("/")]
    others = "/".join(x[0] for x in shared)
    split = {num: tuple(parse_days(d)[0]) for (num, _), d in zip(shared, days)}
    checked = {num: own_days[num] for num in split if own_days.get(num)}
    if any(o != {split[num]} for num, o in checked.items()):
        withheld = f"running days withheld: the Days cell {raw['days_raw']!r} of {others} ({raw['pdf']} p{raw['page']}) contradicts a number's own TAG column"
    elif len(checked) < n - 1:   # every number but one must be confirmed to fix the order
        withheld = f"running days withheld: which group of the Days cell {raw['days_raw']!r} of {others} ({raw['pdf']} p{raw['page']}) belongs to which number is not confirmed by own TAG columns"
    else:
        withheld = None
    nums = [x[0] for x in shared]
    from_t = split_table_cell(raw["from_table"], nums, own_tables or {})
    to_t = split_table_cell(raw["to_table"], nums, own_tables or {})
    out = []
    for k, (num, marks) in enumerate(shared):
        mk = [x for x in marks.split(",") if x]
        out.append({**raw, "bad": False, "number": num, "marker": ",".join(mk), "name": "", "shared": None,
                    "from_table": from_t[num], "to_table": to_t[num],
                    "days_raw": "" if withheld else days[k], "days_withheld": withheld,
                    "arr_days_raw": "" if withheld or len(arr_days) != n else arr_days[k],
                    "footnotes": {x: raw["footnotes"][x] for x in mk},
                    "warnings": [w for w in raw["warnings"] if "unparseable train number cell" not in w] +
                                [f"TAG prints {others} in one column ({raw['pdf']} p{raw['page']}): the times there apply to each number"
                                 + ("" if withheld else f"; running days {days[k]!r} as printed for {num}")]})
    return out, None


class Seg:
    def __init__(self, raw: dict, sid: int, matcher: StationMatcher, stats: Counter):
        self.raw = raw
        self.sid = sid
        self.where = f"{raw['pdf']} p{raw['page']}" + (f".{raw['sub']}" if raw.get("sub") else "")
        self.stops = []
        self.warn = list(raw["warnings"])
        self.gap_error = None
        rel, prev = 0, None
        seen = set()
        raw_stops = []
        for st in raw["stops"]:
            # TAG repeats a junction row around a branch (e.g. Khurda Road before and after
            # Puri); a through train shows the same times in both rows -> keep one.
            k = (normalise(st["name"]), st["arr"], st["dep"])
            if k in seen:
                continue
            seen.add(k)
            raw_stops.append(st)
        for i, st in enumerate(raw_stops):
            code, how = matcher.match(st["name"])
            stats["match_" + how] += 1
            key = code or ("N:" + normalise(st["name"]).replace(" ", ""))
            ev = {}
            for kind in ("arr", "dep"):
                t = st[kind]
                if t is None:
                    continue
                m = mins(t)
                if prev is not None:
                    d = (m - prev) % 1440
                    if d > MAX_GAP:
                        self.gap_error = f"{st['name']}: times in {self.where} go backwards ({d // 60} h gap) - column order not trustworthy"
                    rel += d
                prev = m
                ev[kind] = rel
            cands = matcher.candidates(st["name"]) if how == "ambiguous" else []
            self.stops.append({"key": key, "code": code, "cands": cands, "name": st["name"].strip(), "arr": st["arr"],
                               "dep": st["dep"], "km": st["km"], "flags": list(st["flags"]),
                               "boxed": st["boxed"], "rel": ev, "i": i})
        self.keys = [s["key"] for s in self.stops]

    def sig(self):
        return tuple((s["key"], s["arr"], s["dep"]) for s in self.stops)


def _first_time(st):
    return st["rel"].get("arr", st["rel"].get("dep"))


def pair_offset(a: Seg, b: Seg):
    """Offset o such that global(b) = rel_b + o when global(a) = rel_a, from the
    stations both segments list. Each shared event (arr/dep at one station)
    proposes an offset; the most common proposal wins.
    Returns (offset, support, n_events) or None if nothing is shared."""
    ca, cb = Counter(a.keys), Counter(b.keys)
    shared = [k for k in ca if k in cb and ca[k] == 1 and cb[k] == 1]
    props = []
    for k in shared:
        sa = next(s for s in a.stops if s["key"] == k)
        sb = next(s for s in b.stops if s["key"] == k)
        common = [kind for kind in ("arr", "dep") if kind in sa["rel"] and kind in sb["rel"]]
        for kind in common:
            props.append(sa["rel"][kind] - sb["rel"][kind])
        if not common:
            # junction: one table has only the arrival, the other only the departure.
            # Only a plausible halt (< 3 h) anchors the two tables.
            if "arr" in sa["rel"] and "dep" in sb["rel"]:      # a ends here, b starts here
                dwell = (mins(sb["dep"]) - mins(sa["arr"])) % 1440
                if dwell <= 180:
                    props.append(sa["rel"]["arr"] + dwell - sb["rel"]["dep"])
            elif "dep" in sa["rel"] and "arr" in sb["rel"]:    # b ends here, a starts here
                dwell = (mins(sa["dep"]) - mins(sb["arr"])) % 1440
                if dwell <= 180:
                    props.append(sa["rel"]["dep"] - dwell - sb["rel"]["arr"])
    if not props:
        return None
    best, n = Counter(props).most_common(1)[0]
    return best, n, len(props)


def _components(segs):
    """Connected groups of segments (linked by shared stations) with offsets."""
    left = list(segs)
    comps = []
    while left:
        root = left.pop(0)
        off = {root.sid: 0}
        comp, frontier = [root], [root]
        while frontier:
            a = frontier.pop()
            for b in list(left):
                r = pair_offset(a, b)
                if r is None:
                    continue
                o, n, tot = r
                if n * 2 <= tot:   # no majority among the shared times: cannot anchor
                    continue
                off[b.sid] = off[a.sid] + o
                comp.append(b)
                frontier.append(b)
                left.remove(b)
        comps.append((comp, off))
    return comps


def _same_single_time(p, m):
    """Two stops from different tables that each print one time, the same one, where exactly one
    of them has no clear arrival/departure role and their codes do not conflict."""
    def single(x):
        return (x["arr"] or x["dep"]) if bool(x["arr"]) != bool(x["dep"]) else None
    return (single(p) is not None and single(p) == single(m)
            and bool(p["flags"] & SINGLE_AMBIG) != bool(m["flags"] & SINGLE_AMBIG)
            and not (p["code"] and m["code"] and p["code"] != m["code"]))


def _merge_component(comp, off, warns):
    inst = []
    for s in comp:
        for st in s.stops:
            g = {k: v + off[s.sid] for k, v in st["rel"].items()}
            inst.append({**st, "g": g, "seg": s})
    by_key = defaultdict(list)
    for x in inst:
        by_key[x["key"]].append(x)
    merged = []
    for key, xs in by_key.items():
        xs.sort(key=lambda x: min(x["g"].values()))
        clusters = []
        for x in xs:
            if clusters and min(x["g"].values()) - max(clusters[-1][-1]["g"].values()) <= 360:
                clusters[-1].append(x)
            else:
                clusters.append([x])
        for cl in clusters:
            ev = {}
            for kind in ("arr", "dep"):
                vals = {(x[kind], x["g"][kind]) for x in cl if kind in x["g"]}
                if len(vals) == 1:
                    ev[kind] = next(iter(vals))
                elif len(vals) > 1:
                    shown = " vs ".join(sorted({v[0] for v in vals}))
                    warns.append(f"{cl[0]['name']}: TAG tables print different {'arrival' if kind == 'arr' else 'departure'} times ({shown}); left null")
            a, d = ev.get("arr"), ev.get("dep")
            if a and d and d[1] < a[1]:
                warns.append(f"{cl[0]['name']}: departure before arrival across TAG tables; times left null")
                a = d = None
            if not a and not d:
                continue
            names = Counter(x["name"] for x in cl)
            flags = set(f for x in cl for f in x["flags"])
            if len(cl) > 1 and any(not (set(x["flags"]) & SINGLE_AMBIG) for x in cl):
                flags -= SINGLE_AMBIG
            merged.append({"key": key, "code": cl[0]["code"], "cands": cl[0].get("cands", []), "name": names.most_common(1)[0][0],
                           "arr": a, "dep": d, "flags": flags, "inst": cl,
                           "t": (a or d)[1], "t_end": (d or a)[1]})
    # the same stop named differently in two tables (identical times, different tables)
    merged.sort(key=lambda m: (m["t"], m["t_end"]))
    out = []
    for m in merged:
        p = out[-1] if out else None
        disjoint = p and not ({x["seg"].sid for x in p["inst"]} & {x["seg"].sid for x in m["inst"]})
        if disjoint and _same_single_time(p, m):
            # one table prints the time as an arrival, the other with no clear role (e.g. the boxed
            # terminal "Udaipur City" a 08.05 / "Udaipur" 08.05): the explicit role is used
            explicit = p if not (p["flags"] & SINGLE_AMBIG) else m
            p["arr"], p["dep"], m["arr"], m["dep"] = explicit["arr"], explicit["dep"], explicit["arr"], explicit["dep"]
            for x in (p, m):
                x["flags"] = x["flags"] - SINGLE_AMBIG
        if disjoint and p["arr"] == m["arr"] and p["dep"] == m["dep"]:
            if p["code"] and m["code"] and p["code"] != m["code"]:
                if p["arr"] and p["dep"] and not p.get("conflict"):
                    # the same arrival AND departure at two different stations in two tables: one halt
                    # that the tables name differently (Lucknow LKO / Lucknow Jn. LJN). A train cannot
                    # be at both, and which one it uses is not certain, so the halt is omitted.
                    warns.append(f"{p['name']} / {m['name']}: TAG tables print the same arrival and departure "
                                 f"({p['arr'][0]}/{p['dep'][0]}) at these two different stations; which one the "
                                 f"train uses is not certain, so the stop is omitted")
                    p["conflict"] = True
                    p["inst"] = p["inst"] + m["inst"]
                    continue
                out.append(m)
                continue
            keep, other = (p, m) if (p["code"] or not m["code"]) else (m, p)
            warns.append(f"TAG tables name the same stop differently: {p['name']!r} / {m['name']!r}")
            keep["inst"] = p["inst"] + m["inst"]
            keep["flags"] = p["flags"] | m["flags"]
            out[-1] = keep
            continue
        out.append(m)
    return [m for m in out if not m.get("conflict")]


def _ordered(merged):
    """Sort by global time; equal times are ordered by row order inside a common table."""
    for p, q in zip(merged, merged[1:]):
        if p["t"] == q["t"] and p["t_end"] == q["t_end"]:
            if not ({x["seg"].sid for x in p["inst"]} & {x["seg"].sid for x in q["inst"]}):
                return f"order of {p['name']} and {q['name']} undetermined (same time, different tables)"

    def order_key(m):
        return (m["t"], m["t_end"], min(x["i"] for x in m["inst"]))
    merged.sort(key=order_key)
    return None


def _pdfno(seg):
    return int(seg.raw["pdf"].split(".")[0])


def _refs(text):
    """Table numbers named in a From/To Table cell ("39A", "via 34A", "65/33A") -> PDF numbers."""
    text = re.sub(r"-\d+", "", text or "")  # "26-1" (monsoon sub-table) -> 26
    return {int(x) for x in re.findall(r"(\d{1,3})[A-Z]?", text)}


def _amb_boxed_single(m):
    return bool(m["flags"] & SINGLE_AMBIG) and any(x["boxed"] for x in m["inst"]) and bool(m["arr"]) != bool(m["dep"])


def _starts_run(part):
    m = part[0][0]
    return m["arr"] is None or _amb_boxed_single(m)


def _ends_run(part):
    m = part[0][-1]
    return m["dep"] is None or _amb_boxed_single(m)


def _linked(A, B):
    """TAG's own linkage says the table(s) of B follow those of A."""
    return any(_pdfno(b) in _refs(a.raw["to_table"]) or _pdfno(a) in _refs(b.raw["from_table"])
               for a in A[1] for b in B[1])


def _gap(A, B):
    """Clock minutes from the last time of A to the first time of B (mod 24 h)."""
    la = (A[0][-1]["dep"] or A[0][-1]["arr"])[0]
    fb = (B[0][0]["arr"] or B[0][0]["dep"])[0]
    return (mins(fb) - mins(la)) % 1440


def _chain_parts(parts, warns):
    """Order route pieces that share no station, using only TAG's From/To Table
    linkage plus clock consistency. Ambiguity -> piece left out (reported)."""
    parts = sorted(parts, key=lambda p: -sum(len(x["inst"]) for x in p[0]))
    origins = [p for p in parts if _starts_run(p) and any(x["boxed"] for x in p[0][0]["inst"])]
    chain = [origins[0] if len(origins) == 1 else parts[0]]
    rest = [p for p in parts if p is not chain[0]]
    joins = []
    while not _ends_run(chain[-1]):
        c = [p for p in rest if not _starts_run(p) and _linked(chain[-1], p) and 0 < _gap(chain[-1], p) <= MAX_GAP]
        if len(c) != 1:
            break
        chain.append(c[0])
        rest.remove(c[0])
        joins.append((chain[-2], c[0]))
    while not _starts_run(chain[0]):
        c = [p for p in rest if not _ends_run(p) and _linked(p, chain[0]) and 0 < _gap(p, chain[0]) <= MAX_GAP]
        if len(c) != 1:
            break
        chain.insert(0, c[0])
        rest.remove(c[0])
        joins.append((c[0], chain[1]))
    # shift pieces onto one timeline, left to right
    for A, B in zip(chain, chain[1:]):
        shift = A[0][-1]["t_end"] + _gap(A, B) - B[0][0]["t"]
        for m in B[0]:
            for kind in ("arr", "dep"):
                if m[kind]:
                    m[kind] = (m[kind][0], m[kind][1] + shift)
            m["t"] += shift
            m["t_end"] += shift
    for A, B in joins:
        warns.append(f"route joined between {A[0][-1]['name']} and {B[0][0]['name']} by TAG's From/To Table linkage (no common station); stops in between may be missing")
    merged = [m for p in chain for m in p[0]]
    used = [s for p in chain for s in p[1]]
    lost = [x for p in rest for x in p[0]]
    if lost:
        if len(lost) >= len(merged):
            return None, "route split over TAG tables that share no station and cannot be ordered by TAG's table linkage"
        warns.append(f"{len(lost)} stop(s) ({', '.join(x['name'] for x in lost[:6])}{'...' if len(lost) > 6 else ''}) omitted: their TAG table shares no station with the rest of the route and TAG's table linkage does not place it unambiguously")
    return merged, used



def _km(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def load_equivalences():
    """code -> (group current code, group codes) from data/station_equivalences.json, if built."""
    f = ROOT / "data" / "station_equivalences.json"
    out = {}
    if f.exists():
        for g in json.loads(f.read_text())["groups"]:
            for c in g["codes"]:
                out[c] = (g["current"], set(g["codes"]))
    return out


EQUIV = load_equivalences()
LINE_MIN = 3   # datameet routes needed to place an ambiguous name on the line between its neighbours


def resolve_ambiguous(merged, matcher, warns, stats):
    """Pick a code for stops whose name fits several stations, using the train's
    neighbouring coded stops: the candidate must be clearly closer to the route
    (detour via the candidate vs the direct neighbour-to-neighbour distance) than
    every other candidate. Otherwise the code stays null."""
    coded = [(i, matcher.coords(m["code"])) for i, m in enumerate(merged) if m["code"]]
    orig = [(i, m["code"]) for i, m in enumerate(merged) if m["code"]]   # codes from the name match only
    coded = [(i, c) for i, c in coded if c]
    for i, m in enumerate(merged):
        if m["code"] or not m.get("cands"):
            continue
        stats["ambiguous_stops"] += 1
        # all candidates are verified codes of ONE physical station: any is right; use
        # the one current sources use if it is among them
        grp = {EQUIV[c][0] for c in m["cands"] if c in EQUIV}
        if len(grp) == 1 and all(c in EQUIV for c in m["cands"]) and next(iter(grp)) in m["cands"]:
            m["code"] = next(iter(grp))
            stats["ambiguous_resolved_equiv"] += 1
            warns.append(f"{m['name']}: name fits {', '.join(m['cands'])}, which data/station_equivalences.json verifies as one station; {m['code']} used")
            continue
        cc = [(c, matcher.coords(c)) for c in m["cands"]]
        prev = next((xy for j, xy in reversed(coded) if j < i), None)
        nxt = next((xy for j, xy in coded if j > i), None)
        if any(xy is None for _, xy in cc):
            ok = False
        elif prev and nxt:
            direct = _km(prev, nxt)
            score = sorted(((_km(prev, xy) + _km(xy, nxt) - direct, c) for c, xy in cc))
            ok = score[0][0] <= 0.5 * direct + 30 and score[1][0] - score[0][0] >= 100
        elif prev or nxt:
            nb = prev or nxt
            score = sorted(((_km(nb, xy), c) for c, xy in cc))
            ok = score[0][0] <= 400 and score[1][0] >= 3 * score[0][0] and score[1][0] - score[0][0] >= 100
        else:
            ok = False
        if ok:
            m["code"] = score[0][1]
            stats["ambiguous_resolved"] += 1
            warns.append(f"{m['name']}: name fits {', '.join(m['cands'])}; {m['code']} chosen as the one on this train's route (neighbouring stops)")
            continue
        # same-place stations on different lines (Dadar DR Central / DDR Western): the line through the
        # train's neighbouring coded stops decides (both must exist, and only codes from the name match
        # count: a terminal Dadar is left null, as such trains are often re-terminated). Each candidate is
        # counted in the datameet 2016 routes that serve it between those neighbours; one candidate needs
        # >= LINE_MIN routes and every other none, and every other must itself be served by some 2016
        # route (a code absent from the 2016 routes says nothing about its line). When the zones of the
        # winner and both neighbours are known, the winner's must equal at least one neighbour's.
        pc = next((c for j, c in reversed(orig) if j < i), None)
        nc = next((c for j, c in orig if j > i), None)
        if not (pc and nc):
            stats["ambiguous_unresolved"] += 1
            continue
        sup = sorted(((matcher.line_support(c, pc, nc), c) for c in m["cands"]), reverse=True)
        win = sup[0][1]
        zones = [matcher.zone(x) for x in (win, pc, nc)]
        zone_ok = None in zones or zones[0] in zones[1:]
        # two codes at one point that 2016 routes both serve are one station under two codes (Phalodi
        # PLC/PLCJ): the 2016 route code need not be today's, so no choice is made
        wxy = matcher.coords(win)
        twin = any(wxy and matcher.coords(c) and _km(wxy, matcher.coords(c)) < 0.05 for _, c in sup[1:])
        served = all(matcher.route_pos.get(c) for _, c in sup[1:])
        if sup[0][0] >= LINE_MIN and all(x[0] == 0 for x in sup[1:]) and zone_ok and not twin and served:
            m["code"] = win
            stats["ambiguous_resolved_line"] += 1
            warns.append(f"{m['name']}: name fits {', '.join(m['cands'])}; {win} chosen as the one on the line through "
                         f"{pc} and {nc} ({sup[0][0]} datameet 2016 routes, none via the others)")
        else:
            stats["ambiguous_unresolved"] += 1


def merge_train(num: str, segs: list[Seg]):
    """Returns (stops, info) or (None, reason)."""
    warns: list[str] = []
    badg = [s for s in segs if s.gap_error]
    segs = [s for s in segs if not s.gap_error]
    for s in badg:
        warns.append(f"segment ignored: {s.gap_error}")
    if not segs:
        return None, badg[0].gap_error
    uniq = {}
    for s in segs:
        uniq.setdefault(s.sig(), s)
    segs = sorted(uniq.values(), key=lambda s: -len(s.stops))
    kept = []
    for s in segs:  # drop segments fully contained (same stops, same times) in another
        if any(set(s.sig()) <= set(k.sig()) for k in kept):
            continue
        kept.append(s)
    comps = _components(kept)
    parts = []
    for comp, off in comps:
        m = _merge_component(comp, off, warns)
        if len(m) >= 1:
            err = _ordered(m)
            if err:
                return None, err
            parts.append((m, comp))
    if not parts:
        return None, "no usable stops"
    unanchored_from = None
    if len(parts) == 1:
        merged, used = parts[0]
    else:
        merged, used = _chain_parts(parts, warns)
        if merged is None:
            return None, used
    if len(merged) < 2:
        return None, "fewer than 2 usable stops"
    first, last = merged[0], merged[-1]
    tnames = {normalise(x.raw["name"]).replace(" ", "") for x in used if x.raw["name"]}

    def named(m):  # consistency check only: the stop is one of the terminals named in the train name
        k = normalise(m["name"]).replace(" ", "")
        return len(k) >= 4 and any(k in n for n in tnames)

    for m in merged:
        amb = bool(m["flags"] & SINGLE_AMBIG)
        boxed = any(x["boxed"] for x in m["inst"])
        single = bool(m["arr"]) != bool(m["dep"])
        # A single time at the route's first/last stop is the origin departure / terminal
        # arrival when two signals agree (box, ambiguous a/d role, station named in the
        # train name). An explicit "a" at an unboxed table entry point stays an arrival.
        # an explicit a/d marker is only overridden when TAG boxes the time (run start/end)
        # AND the train name names the station - two independent signals
        end_ok = (amb and (boxed or named(m))) or (boxed and named(m))
        if m is first and single and end_ok:
            if m["arr"]:
                m["dep"], m["arr"] = m["arr"], None
                if not amb:
                    warns.append(f"{OVERRIDE_TAG}: TAG marks the time at {m['name']} as an arrival, but it is boxed and the train name names the station; treated as the origin departure")
        elif m is last and single and end_ok:
            if m["dep"]:
                m["arr"], m["dep"] = m["dep"], None
                if not amb:
                    warns.append(f"{OVERRIDE_TAG}: TAG marks the time at {m['name']} as a departure, but it is boxed and the train name names the station; treated as the terminal arrival")
        elif m is last and m["arr"] and m["dep"] and m["arr"][0] == m["dep"][0] and boxed:
            m["dep"] = None  # one table printed the terminal time as arrival, another as departure
        elif m is first and m["arr"] and m["dep"] and m["arr"][0] == m["dep"][0] and boxed:
            m["arr"] = None  # same at the origin
        elif amb:
            m["role_unknown"] = True
    # the name only confirms an unboxed origin whose role is ambiguous and that no
    # "From Table" cell says is entered from another table
    origin_ok = first["arr"] is None and (
        any(x["boxed"] for x in first["inst"])
        or (named(first) and bool(first["flags"] & SINGLE_AMBIG)
            and not any(x["seg"].raw.get("from_table") for x in first["inst"])))
    if first["arr"]:
        warns.append(f"first listed stop {first['name']} has an arrival time: the origin is not in the parsed TAG tables, so day numbers are not given")
    elif not origin_ok:
        warns.append(f"first listed stop {first['name']} is not marked as the train's origin in TAG (it may start earlier), so day numbers are not given")
    if not (last["dep"] is None and any(x["boxed"] for x in last["inst"])) and not last["dep"]:
        warns.append(f"last listed stop {last['name']} is not marked as the train's destination in TAG (it may run further)")
    if last["dep"]:
        warns.append(f"last listed stop {last['name']} has a departure time: the destination is not in the parsed TAG tables")
    # invariant: every printed clock time must equal origin clock + elapsed minutes
    c0 = mins((first["dep"] or first["arr"])[0]) - (first["dep"] or first["arr"])[1]
    for m in merged:
        for kind in ("arr", "dep"):
            if m[kind] and (c0 + m[kind][1]) % 1440 != mins(m[kind][0]):
                return None, f"elapsed time at {m['name']} does not match its printed time (TAG tables inconsistent)"
    for p, q in zip(merged, merged[1:]):
        if q["t"] - p["t_end"] > MAX_GAP:
            return None, f"{(q['t'] - p['t_end']) // 60} h between {p['name']} and {q['name']} after merging TAG tables (inconsistent versions)"
        if q["t"] < p["t_end"]:
            return None, f"{q['name']} is reached before the train leaves {p['name']} (TAG tables disagree on the route)"
    seen = Counter(m["key"] for m in merged)
    dup = [k for k, c in seen.items() if c > 1]
    if dup:
        return None, f"station listed twice in the merged route ({', '.join(m['name'] for m in merged if m['key'] in dup)[:80]}); TAG row order and times disagree"
    return merged, {"warnings": warns, "segs": used, "unanchored_from": unanchored_from, "origin_ok": origin_ok}


# Prefix of the warning recorded whenever an explicit TAG a/d marker at a terminal is overridden.
OVERRIDE_TAG = "terminal a/d marker overridden"


def _window_complement(w):
    """{"from": "06-10", "to": "10-31"} -> {"from": "11-01", "to": "06-09"} (non-leap calendar)."""
    a = dt.date(2025, int(w["from"][:2]), int(w["from"][3:])) - dt.timedelta(days=1)
    b = dt.date(2025, int(w["to"][:2]), int(w["to"][3:])) + dt.timedelta(days=1)
    return {"from": b.strftime("%m-%d"), "to": a.strftime("%m-%d")}


def _consistent_with(r, mon):
    """A regular-table segment may complete a monsoon variant only if it shares at least
    one station with the monsoon pages and prints identical times at every shared station."""
    mk = defaultdict(list)
    for m in mon:
        for st in m.stops:
            mk[st["key"]].append(st)
    shared = 0
    for st in r.stops:
        for o in mk.get(st["key"], []):
            a = {x for x in (st["arr"], st["dep"]) if x}
            b = {x for x in (o["arr"], o["dep"]) if x}
            # compare the printed times as sets: a single time may sit in different a/d roles
            if not (a <= b or b <= a):
                return False
            for kind in ("arr", "dep"):
                if st[kind] and o[kind] and st[kind] != o[kind]:
                    return False
            shared += 1
    return shared > 0


def build_seasonal(num, reg, mon, matcher, stats, names_for_code):
    """Two entries for a train with Konkan monsoon pages: the monsoon variant (monsoon pages,
    plus regular tables that agree with them wherever both print the train) valid in the
    printed window, and the regular variant valid in the complementary window."""
    wins = Counter((s.raw["season"]["from"], s.raw["season"]["to"]) for s in mon)
    texts = sorted({s.raw["season"]["text"] for s in mon})
    out = []
    mv = rv = None
    mwhy = rwhy = None
    if len(wins) > 1:
        mwhy = f"monsoon pages print different windows {sorted(wins)}"
    else:
        win = {"from": next(iter(wins))[0], "to": next(iter(wins))[1]}
        extra = [r for r in reg if _consistent_with(r, mon)]
        mv, mwhy = build_entry(num, mon + extra, matcher, stats, names_for_code)
        if mv:
            # every published time at a station printed on the monsoon pages must be a time
            # those pages print there (no regular time may stand in for a dropped monsoon stop)
            mt = defaultdict(set)
            for m_ in mon:
                for st in m_.stops:
                    mt[normalise(st["name"])] |= {x for x in (st["arr"], st["dep"]) if x}
            bad = [x for x in mv["stops"] if normalise(x[1]) in mt
                   and not {t for t in (x[2], x[3]) if t} <= mt[normalise(x[1])]]
            if bad:
                mwhy = f"published time at {bad[0][1]} is not one the monsoon pages print there"
                for x in mv["stops"]:   # undo the stats this rejected variant added
                    stats["stops"] -= 1
                    stats["stops_with_code"] -= bool(x[0])
                    if x[0]:
                        names_for_code[x[0]][x[1]] -= 1
                mv = None
        if mv:
            mv["valid"] = win
            w = [f"seasonal timings valid {win['from']} to {win['to']} as printed in TAG ('{texts[0]}'); TAG adds: 'Monsoon timings may change from 10th June'"]
            if extra:
                w.append("stops outside the monsoon pages come from regular TAG tables whose times agree with the monsoon pages at every shared station")
            mv["warnings"] = w + mv.get("warnings", [])
            out.append(mv)
            stats["seasonal_variants"] += 1
    if reg:
        rv, rwhy = build_entry(num, reg, matcher, stats, names_for_code)
    if rv:
        if len(wins) == 1:
            win = {"from": next(iter(wins))[0], "to": next(iter(wins))[1]}
            rv["valid"] = _window_complement(win)
            w = [f"regular (non-monsoon) timings, valid {rv['valid']['from']} to {rv['valid']['to']}"]
        else:
            w = ["regular (non-monsoon) timings; TAG also prints monsoon timings with conflicting windows"]
        if mv is None:
            w.append(f"valid only outside the monsoon window: TAG's monsoon timings for this train could not be used ({mwhy})")
            stats["seasonal_monsoon_dropped"] += 1
        rv["warnings"] = w + rv.get("warnings", [])
        out.append(rv)
    if mv is not None and rv is None and reg:
        mv["warnings"].insert(1, f"valid only inside the monsoon window: TAG's regular timings for this train could not be used ({rwhy})")
        stats["seasonal_regular_dropped"] += 1
        SEASONAL_DROPS[num] = f"regular variant: {rwhy}"
    if rv is not None and mv is None:
        SEASONAL_DROPS[num] = f"monsoon variant: {mwhy}"
    if not out:
        return None, f"monsoon variant: {mwhy}; regular variant: {rwhy or 'no regular pages'}"
    return out, None


SEASONAL_DROPS: dict[str, str] = {}


# ------------------------------------------------------------------ main ---
def build_entry(num, segs, matcher, stats, names_for_code):
    """Merge one train (or one seasonal variant) -> (entry, None) or (None, reason)."""
    merged, info = merge_train(num, segs)
    if merged is None:
        return None, info
    warns = list(info["warnings"])
    used = info["segs"]
    for s in used:
        warns += [w for w in s.warn]
    notes = {}
    for s in used:
        for k, v in s.raw.get("footnotes", {}).items():
            notes.setdefault(v, k)
    for v, k in notes.items():
        warns.append(f"TAG footnote {k} {v}")
    markers = sorted({mk for s in used for mk in s.raw["marker"].split(",") if mk and mk not in s.raw.get("footnotes", {})})
    if markers:
        warns.append(f"train number carries TAG footnote marker(s) {' '.join(markers)}; footnote text not found on the page")
    # origin segment for days / classes
    oseg = merged[0]["inst"][0]["seg"]
    days, dw = parse_days(oseg.raw["days_raw"])
    if dw and oseg.raw.get("days_withheld"):
        dw = oseg.raw["days_withheld"]
    if dw:
        warns.append(dw)
    other_days = {s.raw["days_raw"].replace(" ", "") for s in used} - {oseg.raw["days_raw"].replace(" ", "")}
    if days is not None and other_days:
        parsed_other = {tuple(p) for p in (parse_days(d)[0] for d in other_days) if p is not None}
        if any(p != tuple(days) for p in parsed_other):
            warns.append(f"TAG tables print different running days ({', '.join(sorted(other_days | {oseg.raw['days_raw']}))}); days left null")
            days = None
    cls_raw = Counter(s.raw["classes_raw"] for s in used if s.raw["classes_raw"]).most_common(1)
    classes, cw = parse_classes(cls_raw[0][0] if cls_raw else "")
    if cw:
        warns.append(cw)
    name = clean_name(Counter(s.raw["name"] for s in used if s.raw["name"]).most_common(1)[0][0]) if any(s.raw["name"] for s in used) else ""
    resolve_ambiguous(merged, matcher, warns, stats)
    # stops
    t_first = mins(merged[0]["dep"][0] if merged[0]["dep"] else merged[0]["arr"][0])
    g0 = merged[0]["t"]
    out_stops = []
    for i, m in enumerate(merged):
        arr = m["arr"][0] if m["arr"] else None
        dep = m["dep"][0] if m["dep"] else None
        gt = m["arr"][1] if m["arr"] else m["dep"][1]
        day = 1 + (t_first + gt - g0) // 1440
        if info.get("unanchored_from") is not None and i >= info["unanchored_from"]:
            day = None
        if not info["origin_ok"]:
            day = None  # origin not confirmed: day count cannot be anchored
        km = None  # see meta note: TAG km columns do not give reliable per-train distances
        for f in sorted(m["flags"]):
            if f.startswith("footnote:"):
                warns.append(f"{m['name']}: time printed as {f.split(':', 1)[1]} (TAG footnote marker)")
        if m.get("role_unknown"):
            warns.append(f"{m['name']}: TAG prints a single time {arr or dep} without a clear arrival/departure role; stop omitted")
            continue
        out_stops.append([m["code"], m["name"], arr, dep, day, km])
    dist = None
    if len(out_stops) < 2:
        return None, "fewer than 2 usable stops"
    if out_stops[0][2] is not None:
        warns.append(f"first listed stop {out_stops[0][1]} has an arrival time: the origin is not in the parsed TAG tables")
    if out_stops[-1][3] is not None:
        warns.append(f"last listed stop {out_stops[-1][1]} has a departure time: the destination is not in the parsed TAG tables")
    # final sanity check on what will be published: consecutive events <= 12 h apart
    bad, prev = None, None
    for st_ in out_stops:
        if st_[4] is None:
            prev = None
            continue
        for x in (st_[2], st_[3]):
            if x is None:
                continue
            v = (st_[4] - 1) * 1440 + mins(x)
            if x is st_[3] and st_[2] is not None and mins(st_[3]) < mins(st_[2]):
                v += 1440
            if prev is not None and not (0 <= v - prev <= MAX_GAP):
                bad = st_[1]
            prev = v
    if bad:
        return None, f"published times would jump by more than 12 h at {bad} (stop order not trustworthy)"
    for st_ in out_stops:
        if st_[0]:
            names_for_code[st_[0]][st_[1]] += 1
        stats["stops"] += 1
        stats["stops_with_code"] += bool(st_[0])
    tr = {"n": num, "name": name, "type": train_type(name), "classes": classes, "days": days,
          "dist": dist, "stops": out_stops}
    warns = list(dict.fromkeys(warns))
    if warns:
        tr["warnings"] = warns
    return tr, None


def main():
    t0 = dt.datetime.now(dt.timezone.utc)
    parsed = parse_all()
    matcher = StationMatcher()
    stats = Counter()
    by_num = defaultdict(list)
    by_num_m = defaultdict(list)          # monsoon-page segments
    excluded = {}
    monsoon_nums = set()
    monsoon_unreadable = set()            # trains on a monsoon page whose window could not be read
    page_warnings = []
    sid = 0
    own_days = defaultdict(set)           # number -> running days printed in its own (unshared) columns
    own_tables = defaultdict(set)         # number -> PDFs (tables) holding one of its own (unshared) columns
    for data in parsed.values():
        for raw in data["segments"]:
            d = None if raw["bad"] else parse_days(raw["days_raw"])[0]
            if d is not None:
                own_days[raw["number"]].add(tuple(d))
            if not raw["bad"]:
                own_tables[raw["number"]].add(int(raw["pdf"].split(".")[0]))

    def add_column(raw):
        nonlocal sid
        if not raw["stops"]:
            return
        pieces = split_raw(raw)
        for pc in pieces:
            sid += 1
            sg = Seg(pc, sid, matcher, stats)
            if len(pieces) > 1:
                sg.where += f" (part {pc['piece']} of {len(pieces)})"
            (by_num_m if raw.get("monsoon") else by_num)[raw["number"]].append(sg)
            if raw.get("monsoon"):
                monsoon_nums.add(raw["number"])
    for pdf, data in parsed.items():
        page_warnings += data["warnings"]
        for w in data["warnings"]:
            if "monsoon page without a readable validity window" in w:
                monsoon_unreadable.update(w.split("trains:")[1].split())
        for raw in data["segments"]:
            if raw["bad"]:
                parts, why = split_shared(raw, own_days, own_tables)
                if parts is None:
                    for n in re.findall(r"\d{5}", raw["number"]):
                        excluded.setdefault(n, f"shares a column with another train number ({raw['number']!r}, {pdf} p{raw['page']}): {why}")
                    continue
                stats["shared_column_split"] += 1
            else:
                parts = [raw]
            for raw in parts:
                add_column(raw)
    trains, names_for_code = [], defaultdict(Counter)

    for num in sorted(set(by_num) | set(by_num_m)):
        if num in excluded:
            continue
        reg, mon = by_num.get(num, []), by_num_m.get(num, [])
        if not mon:
            tr, why = build_entry(num, reg, matcher, stats, names_for_code)
            if tr is None:
                excluded[num] = why
                continue
            if num in monsoon_unreadable:
                tr.setdefault("warnings", []).insert(0, "TAG also prints monsoon timings for this train, but their validity window could not be read: these regular timings may not apply during the monsoon")
            trains.append(tr)
            continue
        stats["seasonal_trains"] += 1
        made = build_seasonal(num, reg, mon, matcher, stats, names_for_code)
        if not made[0]:
            excluded[num] = made[1]
            continue
        trains.extend(made[0])
    stations = [matcher.station_tuple(c, names.most_common(1)[0][0]) for c, names in sorted(names_for_code.items())
                if sum(v for v in names.values() if v > 0)]
    data_as_of = find_validity(parsed)
    meta = {
        "id": "tag2026", "name": "Indian Railways Trains at a Glance (TAG) 2026",
        "kind": "official_timetable",
        "source": "https://indianrailways.gov.in/railwayboard/uploads/directorate/coaching/TAG_2026/",
        "data_as_of": data_as_of, "possibly_outdated": False,
        "built_at": t0.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "notes": [
            "Parsed offline from the Railway Board's TAG 2026 PDFs by scripts/tag/build.py; nothing is filled in from other sources.",
            "Stations where TAG prints '...' (no halt / time not shown) are omitted.",
            "Station codes come from name matching (datameet 2016 list + hand-curated aliases); unmatched or ambiguous names keep code=null.",
            "km and dist are always null: TAG km columns are per table, measured from the table's own baseline along its main line (often not the train's origin or path; some tables carry several km columns), and a QA comparison showed errors up to ~100 km, so no distance is published.",
            "day is inferred (TAG does not print it): the day of arrival (of departure at the origin), 1 at the origin, +1 whenever the clock time goes backwards; null when the first listed stop is not confirmed as the origin.",
            "Classes are exactly what TAG 2026 prints for the train (reserved IRCTC classes only); TAG 'II' (general second class) and 'P' (pantry) are not mapped. Coaches added after TAG went to press (e.g. 3E, 1A) and IRCTC's 2S quota on 'II' coaches are not reflected; a column whose class text cannot be read completely gets classes=null.",
            "Konkan-route trains with monsoon pages appear twice with the same n: a monsoon variant and a regular variant, each with valid = {from, to} (MM-DD, inclusive, yearly) as printed in TAG (monsoon 06-10 to 10-31); entries without valid apply all year.",
            f"{len(excluded)} train numbers were excluded because their TAG columns could not be parsed or merged reliably.",
            "Trains retimed after TAG went to press keep TAG's printed times (about 12% of sampled stop times differ from current running); the server's cross-checks flag these as conflicts.",
        ],
    }
    out = {"meta": meta, "stations": stations, "trains": trains}
    with gzip.open(OUT, "wt", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    report = {"stats": dict(stats), "excluded": excluded, "page_warnings": page_warnings,
              "trains": len(trains), "monsoon_trains": sorted(monsoon_nums), "seasonal_variant_dropped": SEASONAL_DROPS}
    REPORT.write_text(json.dumps(report, indent=1))
    with open(HERE / "excluded_trains.csv", "w", newline="") as f:
        import csv
        w = csv.writer(f)
        w.writerow(["train", "reason"])
        for n in sorted(excluded):
            w.writerow([n, excluded[n]])
    print(f"wrote {OUT.relative_to(ROOT)}: {len(trains)} trains, {stats['stops']} stops, {len(stations)} stations; "
          f"{len(excluded)} excluded; report {REPORT.relative_to(ROOT)}")


def find_validity(parsed) -> str:
    return "2026"


if __name__ == "__main__":
    main()
