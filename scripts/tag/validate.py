"""Validate data/tag2026.json.gz.

    python3 scripts/tag/validate.py [--cache DIR] [--no-erail] [--sample N]

1. Coverage: trains, stops, % stops with a station code, top unmatched names.
2. Internal consistency: monotonic times after day rollover, short routes,
   duplicate train numbers, format checks.
3. External spot-check against eRail (QA only - nothing from eRail is written
   to the dataset). Responses are cached in --cache (>= 1 s between requests).
"""
from __future__ import annotations
import os


def _erail_key():
    """Operator-supplied eRail route parameter (see .env.example); needed only for uncached fetches."""
    v = os.environ.get("ERAIL_ROUTE_KEY", "").strip()
    if not v:
        raise SystemExit("ERAIL_ROUTE_KEY is not set (see .env.example); it is needed for uncached eRail route fetches")
    return v

import argparse
import gzip
import json
import pathlib
import random
import re
import subprocess
import sys
import time
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "tag2026.json.gz"
WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
FIXED_SAMPLE = [
    "12951", "12952", "12627", "12628", "12301", "12309", "22436", "22439", "20171", "12002",
    "12138", "12406", "20424", "12839", "12295", "12371", "12251", "22455", "12162", "11605",
    "12050", "12618", "16345", "12779", "15909", "12424", "22691", "12655",
]
TIME_RE = re.compile(r"^\d\d:\d\d$")
CANON: dict[str, str] = {}


def mins(t):
    return int(t[:2]) * 60 + int(t[3:])


# ------------------------------------------------------------ eRail -------
class ERail:
    def __init__(self, cache: pathlib.Path):
        self.cache = cache
        cache.mkdir(parents=True, exist_ok=True)
        self.last = 0.0

    def _get(self, url: str, name: str) -> str:
        f = self.cache / name
        if f.exists():
            return f.read_text()
        wait = 1.05 - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        r = subprocess.run(["curl", "-sS", "--max-time", "30", url], capture_output=True, text=True)
        self.last = time.time()
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip())
        f.write_text(r.stdout)
        return r.stdout

    def train(self, n: str):
        t = self._get(f"https://erail.in/rail/getTrains.aspx?TrainNo={n}&DataSource=0&Language=0&Cache=true",
                      f"train_{n}.txt")
        if "^" not in t:
            return None
        rec = t.split("^")[1].split("~")
        if len(rec) < 34 or rec[0] != n:
            return None
        route = self._get(f"https://erail.in/data.aspx?Action=TRAINROUTE&Password={_erail_key()}&Data1={rec[33]}&Data2=0&Cache=true",
                          f"route_{n}.txt")
        stops = []
        for r in route.split("^")[1:]:
            f = r.split("~")
            if len(f) < 8 or not f[0].isdigit():
                continue
            stops.append({"code": f[1], "name": f[2], "arr": f[3], "dep": f[4], "km": f[6], "day": f[7]})
        # field 13: running days as a 7-char mask, Monday first (checked: 12162 "Sa" -> 0000010)
        mask = rec[13]
        days = [d for i, d in enumerate(WEEK) if mask[i] == "1"] if re.fullmatch(r"[01]{7}", mask) else None
        classes = None
        for fld in rec:
            if re.fullmatch(r"(?:[0-9A-Z]{2}:[^|~]*\|)+", fld):
                classes = {c.split(":")[0] for c in fld.split("|") if c}
                break
        return {"name": rec[1], "days": days, "stops": stops, "classes": classes}


def et(t: str):
    """eRail time 'HH.MM' or 'First'/'Last' -> 'HH:MM' or None."""
    m = re.fullmatch(r"(\d\d)[.:](\d\d)", t or "")
    return f"{m.group(1)}:{m.group(2)}" if m else None


# ----------------------------------------------------------- checks -------
def coverage(d):
    trains = d["trains"]
    stops = [s for t in trains for s in t["stops"]]
    with_code = sum(1 for s in stops if s[0])
    unmatched = Counter(s[1] for s in stops if not s[0])
    print("== 1. Coverage")
    print(f"trains parsed: {len(trains)}")
    print(f"stops parsed: {len(stops)}")
    print(f"stops with station code: {with_code} ({100 * with_code / len(stops):.1f}%)")
    print(f"stations: {len(d['stations'])}")
    print("top 30 unmatched station names:")
    for n, c in unmatched.most_common(30):
        print(f"  {c:4d}  {n}")


def internal(d):
    print("== 2. Internal consistency")
    trains = d["trains"]
    nums = Counter(t["n"] for t in trains)
    # seasonal variants share n: allowed only when every copy has a window and the windows don't overlap
    dups = []
    for n, c in nums.items():
        if c == 1:
            continue
        vs = [t.get("valid") for t in trains if t["n"] == n]
        days = [set(window_days(v)) if v else None for v in vs]
        if any(x is None for x in days) or any(days[i] & days[j] for i in range(len(days)) for j in range(i + 1, len(days))):
            dups.append(n)
    seasonal = sorted({t["n"] for t in trains if t.get("valid")})
    both = [n for n in seasonal if nums[n] == 2]
    print(f"trains with seasonal variants: {len(seasonal)} ({len(both)} with both a monsoon and a regular entry, "
          f"{len(seasonal) - len(both)} with one windowed entry)")
    short = [t["n"] for t in trains if len(t["stops"]) < 2]
    mono, bad = 0, []
    fmt_err = []
    st_codes = {s[0] for s in d["stations"]}
    for t in trains:
        ok = True
        prev = None
        for i, s in enumerate(t["stops"]):
            code, name, arr, dep, day, km = s
            if code and code not in st_codes:
                fmt_err.append(f"{t['n']}: {code} not in stations")
            for x in (arr, dep):
                if x is not None and not TIME_RE.match(x):
                    fmt_err.append(f"{t['n']}: bad time {x}")
            if i == 0 and arr is not None and not any("origin is not" in w for w in t.get("warnings", [])):
                fmt_err.append(f"{t['n']}: origin has arrival")
            if i == len(t["stops"]) - 1 and dep is not None and not any("destination is not" in w for w in t.get("warnings", [])):
                fmt_err.append(f"{t['n']}: destination has departure")
            if day is None:
                prev = None
                continue
            base = (day - 1) * 1440  # day is the day of arrival (of departure at the origin)
            for x in (arr, dep):
                if x is None:
                    continue
                v = base + mins(x)
                if x is dep and arr is not None and mins(dep) < mins(arr):
                    v += 1440  # departs after midnight following the arrival
                if prev is not None and (v < prev or v - prev > 12 * 60):
                    ok = False
                prev = v
        if ok:
            mono += 1
        else:
            bad.append(t["n"])
        if t["days"] is not None and (not t["days"] or any(x not in WEEK for x in t["days"])):
            fmt_err.append(f"{t['n']}: bad days")
    print(f"trains with monotonic times after day rollover (no step back, no >12 h gap): {mono}/{len(trains)} ({100 * mono / len(trains):.1f}%)")
    if bad:
        print(f"  non-monotonic: {' '.join(bad[:30])}")
    ro = sum(1 for t in trains if t["stops"][0][2] is None and t["stops"][0][3] is not None)
    rd = sum(1 for t in trains if t["stops"][-1][3] is None and t["stops"][-1][2] is not None)
    both = sum(1 for t in trains if t["stops"][0][2] is None and t["stops"][-1][3] is None)
    print(f"first stop is a real origin (departure only): {ro}/{len(trains)} ({100 * ro / len(trains):.1f}%)")
    print(f"last stop is a real destination (arrival only): {rd}/{len(trains)} ({100 * rd / len(trains):.1f}%)")
    print(f"both terminals present: {both}/{len(trains)} ({100 * both / len(trains):.1f}%)")
    print(f"trains with < 2 stops: {len(short)}")
    print(f"duplicate train numbers (other than non-overlapping seasonal variants): {len(dups)} {' '.join(dups[:20])}")
    print(f"format errors: {len(fmt_err)} {fmt_err[:10]}")
    w = sum(1 for t in trains if t.get("warnings"))
    print(f"trains carrying warnings: {w}")
    print(f"trains with km: {sum(1 for t in trains if t['dist'] is not None)}; with days: {sum(1 for t in trains if t['days'])}; with classes: {sum(1 for t in trains if t['classes'])}")


def load_equiv():
    f = ROOT / "data" / "station_equivalences.json"
    canon = {}
    if f.exists():
        for g in json.loads(f.read_text())["groups"]:
            for c in g["codes"]:
                canon[c] = g["current"]
    return canon


def window_days(v):
    """All MM-DD in an inclusive yearly window (wrapping over new year)."""
    import datetime as dt
    out, day = [], dt.date(2025, int(v["from"][:2]), int(v["from"][3:]))
    end = dt.date(2025, int(v["to"][:2]), int(v["to"][3:]))
    while True:
        out.append(day.strftime("%m-%d"))
        if day == end:
            return out
        day += dt.timedelta(days=1)
        if day.year > 2025:
            day = dt.date(2025, 1, 1)


def in_force(entries, today):
    """The entry valid on `today` (MM-DD): a windowed one containing it, else one without a window."""
    for t in entries:
        if t.get("valid") and today in window_days(t["valid"]):
            return t
    plain = [t for t in entries if not t.get("valid")]
    return plain[0] if plain else None


def compare_times(t, e):
    ec = {}
    for s in e["stops"]:
        ec.setdefault(CANON.get(s["code"], s["code"]), s)
    ok = n = 0
    for code, name, arr, dep, day, km in t["stops"]:
        es = ec.get(CANON.get(code, code)) if code else None
        if not es:
            continue
        for ours, theirs in ((arr, et(es["arr"])), (dep, et(es["dep"]))):
            if ours is None:
                continue
            n += 1
            ok += ours == theirs
    return ok, n


def konkan(d, cache, max_new=40):
    """Seasonal (monsoon) trains: compare each variant with eRail, which shows today's timings."""
    import datetime as dt
    today = dt.date.today().strftime("%m-%d")
    print(f"== 4. Seasonal (Konkan monsoon) variants vs eRail (today {today})")
    by_n = {}
    for t in d["trains"]:
        if t.get("valid"):
            by_n.setdefault(t["n"], []).append(t)
    er = ERail(cache)
    fetched = 0
    tot = Counter()
    for n in sorted(by_n):
        if not (cache / f"route_{n}.txt").exists():
            if fetched >= max_new:
                tot["skipped_budget"] += 1
                continue
            fetched += 1
        try:
            e = er.train(n)
        except Exception:
            tot["erail_failed"] += 1
            continue
        if not e or not e["stops"]:
            tot["not_on_erail"] += 1
            continue
        for t in by_n[n]:
            kind = "monsoon" if t["valid"]["from"] == "06-10" else "regular"   # the window TAG prints for monsoon pages
            ok, cnt = compare_times(t, e)
            tot[kind + "_ok"] += ok
            tot[kind + "_n"] += cnt
            tot[kind + "_trains"] += 1
    for kind in ("monsoon", "regular"):
        n_, ok = tot[kind + "_n"], tot[kind + "_ok"]
        live = any(today in window_days(t["valid"]) for v in by_n.values() for t in v
                   if (t["valid"]["from"] == "06-10") == (kind == "monsoon"))
        print(f"{kind} variants (valid today: {live}): {tot[kind + '_trains']} trains, times equal to eRail "
              f"{ok}/{n_} ({100 * ok / n_ if n_ else 0:.1f}%)")
    print(f"seasonal trains not on eRail: {tot['not_on_erail']}; eRail failures: {tot['erail_failed']}; "
          f"skipped (fetch budget {max_new}): {tot['skipped_budget']}; new eRail fetches: {fetched}")


def spot(d, cache, sample_n):
    print("== 3. External spot-check vs eRail (QA only)")
    import datetime as dt
    today = dt.date.today().strftime("%m-%d")
    groups = {}
    for t in d["trains"]:
        groups.setdefault(t["n"], []).append(t)
    # the entry in force today (seasonal trains have two)
    trains = {n: x for n, x in ((n, in_force(v, today)) for n, v in groups.items()) if x}
    rnd = random.Random(2026)
    # stable sample: order by a hash of the train number, so the same trains are drawn
    # across rebuilds even when other trains are added or excluded
    import hashlib
    pool = sorted((n for n in trains if n not in FIXED_SAMPLE), key=lambda n: hashlib.sha1(n.encode()).hexdigest())
    sample = [n for n in FIXED_SAMPLE if n in trains] + pool[:max(0, sample_n - len(FIXED_SAMPLE))]
    missing_fixed = [n for n in FIXED_SAMPLE if n not in trains]
    if missing_fixed:
        print(f"fixed-sample trains not in dataset (excluded or absent from TAG): {' '.join(missing_fixed)}")
    er = ERail(cache)
    tot = Counter()
    mism = []
    for n in sample:
        t = trains[n]
        e = er.train(n)
        if not e or not e["stops"]:
            mism.append(f"{n}: not found on eRail")
            tot["not_on_erail"] += 1
            continue
        seasonal = False  # seasonal trains are compared with the variant in force today
        if seasonal:
            # eRail shows the timings in force today; Konkan trains run monsoon timings 10 Jun - 31 Oct
            tot["seasonal_skipped"] += 1
            mism.append(f"{n}: Konkan train, TAG non-monsoon timings vs eRail current timings - not compared")
            continue
        tot["trains"] += 1
        amb = {re.match(r"^(.*): single time (\d\d:\d\d)", w).groups() for w in t.get("warnings", [])
               if re.match(r"^(.*): single time (\d\d:\d\d)", w)}
        ecode = {}
        for s in e["stops"]:
            ecode.setdefault(CANON.get(s["code"], s["code"]), s)
        tm = []
        for code, name, arr, dep, day, km in t["stops"]:
            if not code:
                tot["stops_no_code"] += 1
                continue
            tot["stops_checked"] += 1
            es = ecode.get(CANON.get(code, code))
            if not es:
                tm.append(f"{name}({code}) not on eRail route")
                continue
            tot["stops_found"] += 1
            if (name, dep) in amb:
                tot["amb_checked"] += 1
                tot["amb_eq_dep"] += dep == et(es["dep"])
                tot["amb_eq_arr"] += dep == et(es["arr"])
            for kind, ours, theirs in (("arr", arr, et(es["arr"])), ("dep", dep, et(es["dep"]))):
                if ours is None:
                    continue
                tot["times_checked"] += 1
                if ours == theirs:
                    tot["times_match"] += 1
                else:
                    tm.append(f"{name} {kind} {ours} vs {theirs or es[kind]}")
            if day is not None and es["day"].isdigit():
                tot["days_checked"] += 1
                if int(es["day"]) == day:
                    tot["day_match"] += 1
                else:
                    tm.append(f"{name} day {day} vs {es['day']}")
        if t["days"] and e["days"]:
            tot["run_days_checked"] += 1
            if t["days"] == e["days"]:
                tot["run_days_match"] += 1
            else:
                tm.append(f"running days {','.join(t['days'])} vs {','.join(e['days'])}")
        if t["classes"] is not None and e["classes"]:
            tot["classes_checked"] += 1
            ours = set(t["classes"])
            theirs = e["classes"] & {"1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S", "FC", "EA", "EV"}
            if ours - {"2S"} == theirs - {"2S"}:
                tot["classes_equal_x2s"] += 1
            if ours == theirs:
                tot["classes_equal"] += 1
            elif ours <= theirs:
                tot["classes_subset"] += 1
                tm.append(f"classes {','.join(sorted(ours))} vs {','.join(sorted(theirs))}")
            else:
                tm.append(f"classes {','.join(sorted(ours))} vs {','.join(sorted(theirs))}")
        kmstops = [(CANON.get(s[0], s[0]), s[5]) for s in t["stops"]
                   if CANON.get(s[0], s[0]) in ecode and s[5] is not None and ecode[CANON.get(s[0], s[0])]["km"].isdigit()]
        if len(kmstops) >= 2:
            base_o, base_e = kmstops[0][1], int(ecode[kmstops[0][0]]["km"])
            for code, k in kmstops[1:]:
                tot["km_checked"] += 1
                de = int(ecode[code]["km"]) - base_e
                if abs((k - base_o) - de) <= 2:
                    tot["km_close"] += 1
                else:
                    tm.append(f"km {kmstops[0][0]}->{code} {k - base_o} vs {de}")
        tot["term_checked"] += 1
        cn = lambda c: CANON.get(c, c)
        if t["stops"][0][0] == e["stops"][0]["code"] and t["stops"][-1][0] == e["stops"][-1]["code"]:
            tot["term_equal_raw"] += 1
        if cn(t["stops"][0][0]) == cn(e["stops"][0]["code"]) and cn(t["stops"][-1][0]) == cn(e["stops"][-1]["code"]):
            tot["term_equal"] += 1
        else:
            tm.append(f"terminals {t['stops'][0][0]}-{t['stops'][-1][0]} vs {e['stops'][0]['code']}-{e['stops'][-1]['code']}")
        ours_codes = {CANON.get(s[0], s[0]) for s in t["stops"] if s[0]}
        missing = [s["code"] for s in e["stops"] if CANON.get(s["code"], s["code"]) not in ours_codes]
        tot["erail_stops"] += len(e["stops"])
        tot["erail_stops_in_tag"] += len(e["stops"]) - len(missing)
        if tm:
            mism.append(f"{n} {t['name']}: " + "; ".join(tm))
    pct = lambda a, b: f"{100 * tot[a] / tot[b]:.1f}%" if tot[b] else "n/a"
    print(f"trains compared: {tot['trains']} (sample {len(sample)}, not on eRail {tot['not_on_erail']})")
    print(f"TAG stops (with code) found on eRail route: {tot['stops_found']}/{tot['stops_checked']} ({pct('stops_found', 'stops_checked')})")
    print(f"times (arr/dep) equal to eRail: {tot['times_match']}/{tot['times_checked']} ({pct('times_match', 'times_checked')})")
    print(f"day numbers equal to eRail: {tot['day_match']}/{tot['days_checked']} ({pct('day_match', 'days_checked')})")
    print(f"running days equal to eRail: {tot['run_days_match']}/{tot['run_days_checked']} ({pct('run_days_match', 'run_days_checked')})")
    print(f"origin and destination equal to eRail's (modulo station_equivalences.json): {tot['term_equal']}/{tot['term_checked']} ({pct('term_equal', 'term_checked')}); exact codes: {tot['term_equal_raw']}/{tot['term_checked']}")
    print(f"km from first stop within 2 km of eRail: {tot['km_close']}/{tot['km_checked']} ({pct('km_close', 'km_checked')})")
    print(f"class lists equal to eRail: {tot['classes_equal']}/{tot['classes_checked']} ({pct('classes_equal', 'classes_checked')}); TAG a strict subset of eRail: {tot['classes_subset']}; equal ignoring 2S: {tot['classes_equal_x2s']}")
    print(f"eRail stops present in TAG train (recall incl. unmatched names): {tot['erail_stops_in_tag']}/{tot['erail_stops']} ({pct('erail_stops_in_tag', 'erail_stops')})")
    print(f"single times of unclear a/d role (kept as departure): {tot['amb_checked']} checked, equal to eRail departure {tot['amb_eq_dep']}, equal to eRail arrival {tot['amb_eq_arr']}")
    print(f"Konkan trains skipped (seasonal timings): {tot['seasonal_skipped']}")
    print("mismatches:")
    for m in mism:
        print("  " + m)
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=str(ROOT / "data" / "raw" / "tag2026" / "erail_cache"))
    ap.add_argument("--no-erail", action="store_true")
    ap.add_argument("--sample", type=int, default=40)
    a = ap.parse_args()
    global CANON
    CANON = load_equiv()
    d = json.load(gzip.open(DATA))
    coverage(d)
    internal(d)
    if not a.no_erail:
        spot(d, pathlib.Path(a.cache), a.sample)
        konkan(d, pathlib.Path(a.cache))


if __name__ == "__main__":
    main()
