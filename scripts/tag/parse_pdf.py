"""Parse one TAG 2026 PDF into raw per-table train "segments".

Layout facts this relies on (verified on the 2026 PDFs):
  * Every timetable page is a ruled grid. Row boundaries are horizontal rule
    segments in the station-name area; train columns are bounded by vertical
    rules that run the full height of the table.
  * Single-direction tables: label/station area on the left, trains to the
    right, read top -> bottom.
    Two-direction tables: station area in the middle; trains left of it read
    top -> bottom, trains right of it read bottom -> top.
  * Header label rows: TRAIN NAME, Train Number, Class of accommodation,
    From Table No., Days of departure/operation. Footer: days of arrival,
    To Table No.
  * A station row may carry an "a" and a "d" marker line; a time is printed on
    the line it belongs to. Duplicated overlapping glyphs are removed with
    dedupe_chars and lines are kept apart with a tight y tolerance.
  * A train's first/last time inside a table is boxed (short rules around it).
  * Notes inside a train cell ("Khajuraho Arr. 12.55", "DLI 09.50 10.05") name
    a station that is not a row of the table (an "inset" stop).

Nothing here guesses: anything that does not fit is reported as a warning
and the affected stop is dropped or keeps null times.
"""
from __future__ import annotations

import os
import re
from collections import Counter
import sys
from dataclasses import dataclass, field, asdict

import pdfplumber

TIME_RE = re.compile(r"^([01]?\d|2[0-4])[.:]([0-5]\d)([@*#$+^~!†]*)$")
DOTS_RE = re.compile(r"^(\.{2,}|…+|-+|–|—)$")
MARK = r"[*#@$+^~!†]"
# a train number with footnote markers before and/or after it ("12345*", "#15053**", "15036#,**", "15073†")
TRAIN_RE = re.compile(rf"^({MARK}*)(\d{{5}})((?:,?{MARK}+)*)$")
# several numbers sharing one column ("12330/12380", "20686*/20694**", "20828/ 22170")
SHARED_RE = re.compile(rf"^\d{{5}}{MARK}*(?:\s*/\s*\d{{5}}{MARK}*)+$")


def _markers(*parts: str) -> list[str]:
    """Marker groups of a number cell: "#", "**" from "#15053**"; "#", "**" from "15036#,**"."""
    return [g for p in parts for g in p.split(",") if g]
KM_RE = re.compile(r"^\d{1,4}$")
KM_LABEL = {"km", "km.", "kms", "kms."}
HEADER_RE = re.compile(r"^(CLASS|FROM|DAYS|DEP|ARR|ORIGINATING|ORGINATING|PANTRY|TYPE|RAKE|COACH|TO TABLE|ACCOMMODATION)")


@dataclass
class Stop:
    name: str
    km: int | None
    arr: str | None
    dep: str | None
    boxed: bool = False
    flags: list[str] = field(default_factory=list)


@dataclass
class Segment:
    pdf: str
    page: int                     # 1-based page in the pdf
    table: str | None             # table number printed on the page, if found
    sub: int                      # table index on a page holding several tables (0 = only one)
    side: str                     # "R" or "L" of the station/label area
    col: int
    number: str                   # 5-digit train number (or raw cell text if unparseable)
    marker: str                   # footnote markers of the number, comma-separated groups ("*", "#,**")
    name: str
    classes_raw: str
    from_table: str
    to_table: str
    days_raw: str
    arr_days_raw: str
    stops: list[Stop]
    warnings: list[str] = field(default_factory=list)
    bad: bool = False             # column could not be parsed reliably
    monsoon: bool = False         # page holds seasonal (monsoon) timings
    season: dict | None = None    # {"from": "MM-DD", "to": "MM-DD", "text": ...} printed on a seasonal page
    footnotes: dict = field(default_factory=dict)  # page footnote text for markers used by this column
    shared: list | None = None    # [[number, markers], ...] when several numbers share the column (bad=True)


def _cluster(vals, tol=1.2):
    out = []
    for v in sorted(vals):
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(c) / len(c) for c in out]


def _weighted_rules(vsegs, xmin, xmax):
    """x of vertical grid rules: clusters with a large summed length (box
    outlines around single times are short and few)."""
    cand = sorted((l["x0"], l["bottom"] - l["top"]) for l in vsegs if xmin < l["x0"] < xmax)
    groups = []
    for x, ln in cand:
        if groups and x - groups[-1][0][-1] <= 1.2:
            groups[-1][0].append(x)
            groups[-1][1] += ln
        else:
            groups.append([[x], ln])
    if not groups:
        return []
    top = max(g[1] for g in groups)
    return [sum(g[0]) / len(g[0]) for g in groups if g[1] >= 0.4 * top]


def _lines(words):
    lines = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(w["top"] - lines[-1][0]) < 2:
            lines[-1][1].append(w)
        else:
            lines.append([w["top"], [w]])
    return [sorted(ws, key=lambda x: x["x0"]) for _, ws in lines]


def _join_lines(words):
    """Join words of a multi-line cell in reading order; re-join hyphenation."""
    text = ""
    for ws in _lines(words):
        part = " ".join(x["text"] for x in ws)
        if text.endswith("-") and not text.endswith(" -") and part[:1].islower():
            text = text[:-1] + part
        else:
            text = (text + " " + part).strip()
    return re.sub(r"\s+", " ", text).strip()


def norm_time(s):
    m = TIME_RE.match(s)
    if not m:
        return None
    h = int(m.group(1))
    if h == 24:
        if m.group(2) != "00":
            return None
        h = 0  # "24.00" = midnight at the end of the day; rollover logic adds the day
    return f"{h:02d}:{m.group(2)}"


def _split_tokens(words):
    """Split glued tokens such as 'Arr.13.15' / 'Dep18.16' into separate words."""
    out = []
    for w in words:
        t = w["text"].replace("­", "").strip()
        if not t:
            continue
        m = re.fullmatch(r"(Arr|Dep|arr|dep)\.?(\d{1,2}\.\d{2}[@*#$]*)", t)
        if m:
            out.append({**w, "text": m.group(1).capitalize() + "."})
            out.append({**w, "text": m.group(2), "top": w["top"] + 0.01})
            continue
        out.append({**w, "text": t})
    return out


def _union(iv, tol=1.5):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1] + tol:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def _table_regions(pg, labels):
    """Split a page holding several grids into one bbox per "Train Number" label.
    Grids are separated by blank gaps: the horizontal rules around the label
    row give each table's x-range, the vertical rules inside that x-range its
    y-range."""
    objs = pg.lines + pg.rects
    regions = []
    for lab in labels:
        y = (lab["top"] + lab["bottom"]) / 2
        hs = [(o["x0"], o["x1"]) for o in objs if abs(o["top"] - o["bottom"]) < 1.5 and lab["top"] - 40 <= o["top"] <= lab["bottom"] + 40]
        hs += [(o["x0"], o["x1"]) for o in pg.rects if o["height"] >= 1.5 and o["top"] - 0.5 <= y <= o["bottom"] + 0.5]
        xr = next((iv for iv in _union(hs) if iv[0] - 3 <= lab["x0"] and lab["x1"] <= iv[1] + 3 and iv[1] - iv[0] > 100), None)
        if xr is None and hs and not any(o is not lab and abs(o["top"] - lab["top"]) < 30 for o in labels):
            # broken rules around the label row, and no other table beside it: use the full rule span
            xr = [min(a for a, _ in hs), max(b for _, b in hs)]
        if xr is None:
            return None
        vs = [(o["top"], o["bottom"]) for o in objs if abs(o["x0"] - o["x1"]) < 1.5 and xr[0] - 1 <= o["x0"] <= xr[1] + 1]
        vs += [(o["top"], o["bottom"]) for o in pg.rects if o["width"] >= 1.5 and o["x0"] >= xr[0] - 1 and o["x1"] <= xr[1] + 1]
        yr = next((iv for iv in _union(vs) if iv[0] <= y <= iv[1]), None)
        if yr is None:
            return None
        regions.append((max(0, xr[0] - 1), max(0, yr[0] - 1), min(pg.width, xr[1] + 1), min(pg.height, yr[1] + 1)))
    for i in range(len(regions)):
        for j in range(i + 1, len(regions)):
            a, b = regions[i], regions[j]
            if a[0] < b[2] - 2 and b[0] < a[2] - 2 and a[1] < b[3] - 2 and b[1] < a[3] - 2:
                return None
    return regions


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _season_window(text: str):
    """'Monsoon Timings : 10th June to 31st October' -> {"from": "06-10", "to": "10-31"}."""
    m = re.search(r"(?i)monsoon\s+timings?\s*:?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*(?:to|-|–)\s*"
                  r"(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})", text)
    if not m:
        return None
    m1, m2 = MONTHS.get(m.group(2)[:3].lower()), MONTHS.get(m.group(4)[:3].lower())
    if not m1 or not m2:
        return None
    return {"from": f"{m1:02d}-{int(m.group(1)):02d}", "to": f"{m2:02d}-{int(m.group(3)):02d}", "text": m.group(0)}


def _footnotes(words) -> dict[str, str]:
    """Footnote lines below a grid: lines starting with a marker such as "*", "**", "#", "†"."""
    notes: dict[str, str] = {}
    cur, prev_bottom = None, None
    for ln in _lines(words):
        txt = " ".join(w["text"] for w in ln)
        top = min(w["top"] for w in ln)
        m = re.match(r"^([*#@$†]+)\s*(.+)", txt)
        if m:
            cur = m.group(1)
            notes[cur] = (notes.get(cur, "") + " " + m.group(2)).strip()
        elif cur and not re.fullmatch(r"\d{1,4}", txt) and prev_bottom is not None and top - prev_bottom < 4:
            notes[cur] = (notes[cur] + " " + txt).strip()   # continuation line directly below
        else:
            cur = None
        prev_bottom = max(w["bottom"] for w in ln)
    return notes


def parse_page(pdf_name: str, pno: int, page, _cropped=False, _sub=0, _notes=None) -> tuple[list[Segment], list[str]]:
    pw: list[str] = []
    tag = f"{pdf_name} p{pno}" + (f".{_sub}" if _sub else "")
    # drop rotated glyphs (the vertical "TAG-26" margin label)
    pg = page.dedupe_chars().filter(lambda o: o.get("object_type") != "char" or o.get("upright", True))
    words = _split_tokens(pg.extract_words(x_tolerance=1.5, y_tolerance=1, keep_blank_chars=False))
    top_words = [w["text"] for w in words if w["top"] < 120]
    monsoon = "MONSOON" in top_words  # seasonal Konkan pages, e.g. "26-1 MONSOON"
    # --- "Train Number" label -------------------------------------------
    lab = None
    for w in words:
        if w["text"] == "Train":
            for v in words:
                if v["text"].startswith("Number") and abs(v["top"] - w["top"]) < 2 and 0 < v["x0"] - w["x1"] < 8:
                    lab = (w, v)
                    break
        if lab:
            break
    if not lab:
        return [], []
    labels = [w for w in words if w["text"] == "Train" and page.bbox[0] <= w["x0"] <= page.bbox[2] and any(
        v["text"].startswith("Number") and abs(v["top"] - w["top"]) < 2 and 0 < v["x0"] - w["x1"] < 8 for v in words)]
    if len(labels) > 1 and not _cropped:
        regions = _table_regions(pg, labels)
        if regions is None:
            return [], [f"{tag}: {len(labels)} tables on one page could not be separated; page skipped"]
        segs, warns = [], []
        # Footnotes printed outside the crops: in the gap below each table, or below the lowest one (55.pdf
        # prints all of them there). A marker defined once on the page applies to every table; a marker
        # defined in several gaps (52.pdf "*" under each table) only to the table directly above its gap.
        blocks = []
        for r in regions:
            below = [o[1] for o in regions if o[1] >= r[3] - 1]
            blocks.append(_footnotes([w for w in words if r[3] < w["top"] < min(below + [pg.height + 1])
                                      and r[0] - 5 <= w["x0"] <= r[2]]))
        defined = Counter(k for b in blocks for k in b)
        once = {k: v for b in blocks for k, v in b.items() if defined[k] == 1}
        for k, bbox in enumerate(regions):
            own = {mk: v for mk, v in blocks[k].items() if defined[mk] > 1}
            s2, w2 = parse_page(pdf_name, pno, page.crop(bbox), _cropped=True, _sub=k + 1, _notes={**once, **own})
            segs += s2
            warns += w2
        return segs, warns
    if len(labels) > 1:
        return [], [f"{tag}: several tables left in a cropped region; skipped"]
    tn_top = lab[0]["top"]
    lab_x0, lab_x1 = lab[0]["x0"], lab[1]["x1"]
    tnums = [w for w in words if abs(w["top"] - tn_top) < 2.5 and (w["x0"] > lab_x1 or w["x1"] < lab_x0)
             and re.search(r"\d{3}", w["text"])]
    if not tnums:
        return [], [f"{tag}: Train Number row has no numbers"]
    season = None
    if monsoon:  # seasonal page: the validity window is printed in its title
        season = _season_window(" ".join(w["text"] for w in words))
        if season is None:
            nums = sorted({n for w in tnums for n in re.findall(r"\d{5}", w["text"])})
            return [], [f"{tag}: monsoon page without a readable validity window; skipped; trains: {' '.join(nums)}"]

    # rules: drawn lines plus zero-width rectangles (some pages draw rules that way)
    hsegs = [l for l in pg.lines if abs(l["top"] - l["bottom"]) < 0.5]
    vsegs = [l for l in pg.lines if abs(l["x0"] - l["x1"]) < 0.5]
    for r in pg.rects:
        if r["width"] < 1.5 and r["height"] > 4:
            vsegs.append({"x0": r["x0"], "x1": r["x0"], "top": r["top"], "bottom": r["bottom"]})
        elif r["height"] < 1.5 and r["width"] > 4:
            hsegs.append({"x0": r["x0"], "x1": r["x1"], "top": r["top"], "bottom": r["top"]})
    # fallback for grids drawn only as filled cell rectangles: their edges
    rect_v = []
    for r in pg.rects:
        if r["width"] > 4 and r["height"] > 4:
            rect_v.append({"x0": r["x0"], "x1": r["x0"], "top": r["top"], "bottom": r["bottom"]})
            rect_v.append({"x0": r["x1"], "x1": r["x1"], "top": r["top"], "bottom": r["bottom"]})
            if not hsegs:
                pass
    if not hsegs:
        for r in pg.rects:
            if r["width"] > 4 and r["height"] > 4:
                hsegs.append({"x0": r["x0"], "x1": r["x1"], "top": r["top"], "bottom": r["top"]})
                hsegs.append({"x0": r["x0"], "x1": r["x1"], "top": r["bottom"], "bottom": r["bottom"]})
    vx = _weighted_rules(vsegs, page.bbox[0] - 1, page.bbox[2] + 1)
    vx_rect = _weighted_rules(rect_v, page.bbox[0] - 1, page.bbox[2] + 1)
    cols = []
    srt = sorted(tnums, key=lambda w: w["x0"])
    for wi, w in enumerate(srt):
        left = [x for x in vx if x <= w["x0"] + 0.5]
        right = [x for x in vx if x >= w["x1"] - 0.5]
        if not left or not right:
            left = left or [x for x in vx_rect if x <= w["x0"] + 0.5]
            right = right or [x for x in vx_rect if x >= w["x1"] - 0.5]
        # outermost columns of a cropped table: the table border is the crop edge
        if not left and wi == 0 and _cropped:
            left = [page.bbox[0]]
        if not right and wi == len(srt) - 1 and _cropped:
            right = [page.bbox[2]]
        if not left or not right:
            pw.append(f"{tag}: no column rules around {w['text']}")
            continue
        x0, x1 = max(left), min(right)
        if cols and abs(cols[-1]["x0"] - x0) < 0.5:
            cols[-1]["text"] += " " + w["text"]  # e.g. "12330/ 12380"
        else:
            cols.append({"x0": x0, "x1": x1, "text": w["text"], "side": "L" if w["x1"] < lab_x0 else "R"})
    if not cols:
        return [], pw
    lcols = [c for c in cols if c["side"] == "L"]
    rcols = [c for c in cols if c["side"] == "R"]
    two_dir = bool(lcols) and bool(rcols)
    if lcols and not rcols:
        pw.append(f"{tag}: trains only left of the labels; layout not supported")
        return [], pw
    L = max(c["x1"] for c in lcols) if lcols else 0.0
    R = min(c["x0"] for c in rcols)
    # row boundaries: horizontal rules inside the station/label area
    hy = _cluster([l["top"] for l in hsegs if l["x0"] < R - 2 and l["x1"] > L + 2 and (l["x1"] - l["x0"]) > 3])
    if len(hy) < 6:
        return [], pw + [f"{tag}: too few row rules ({len(hy)})"]
    bands = list(zip(hy[:-1], hy[1:]))

    def in_band(w, y0, y1):
        # half-open so a word on a boundary belongs to exactly one band
        c = (w["top"] + w["bottom"]) / 2
        return y0 <= c < y1 or (y1 == hy[-1] and c == y1)

    def band_words(y0, y1, x0, x1):
        return [w for w in words if in_band(w, y0, y1) and x0 <= (w["x0"] + w["x1"]) / 2 <= x1]

    def label(i):
        return _join_lines(band_words(*bands[i], L + 0.5, R - 0.5))

    tn_band = next((i for i, (a, b) in enumerate(bands) if a - 0.5 <= (lab[0]["top"] + lab[0]["bottom"]) / 2 <= b + 0.5), None)
    if tn_band is None:
        return [], pw + [f"{tag}: Train Number label outside grid"]
    name_top = None
    for i in range(tn_band - 1, -1, -1):
        if "TRAIN" in label(i).upper():
            name_top = i
            break
    header, body_start = {}, None
    for i in range(tn_band + 1, len(bands)):
        u = label(i).upper()
        if u.startswith("CLASS") or u.startswith("ACCOMMODATION"):
            header["class"] = i
        elif "TABLE" in u and ("FROM" in u or u.startswith("TO") or u.startswith("TABLE")):
            header["from"] = i
        elif "DAYS" in u or u.startswith("DEP"):
            header["days"] = i
        elif HEADER_RE.match(u):
            header.setdefault("other", []).append(i)
        else:
            body_start = i
            break
    if body_start is None or "days" not in header:
        return [], pw + [f"{tag}: header rows not recognised"]
    if "other" in header:
        pw.append(f"{tag}: extra header rows ignored: {[label(i) for i in header['other']]}")

    # table number printed large near the top
    table = None
    big = [w for w in words if w["bottom"] < tn_top and re.fullmatch(r"\d{1,3}[A-Z]?(-\d)?", w["text"])
           and w["bottom"] - w["top"] > 15]
    if big:
        table = max(big, key=lambda w: w["bottom"] - w["top"])["text"]

    # boxed time: short rule just below a word that is not a row boundary
    short_h = [l for l in hsegs if 8 < l["x1"] - l["x0"] < 45 and not any(abs(l["top"] - y) < 0.8 for y in hy)]

    def is_boxed(w):
        # a box = short rules just below AND just above the time (some boxes hug the glyphs)
        below = any(l["x0"] <= w["x0"] + 0.5 and l["x1"] >= w["x1"] - 0.5 and -1.5 <= l["top"] - w["bottom"] <= 4
                    for l in short_h)
        above = any(l["x0"] <= w["x0"] + 0.5 and l["x1"] >= w["x1"] - 0.5 and -1.5 <= w["top"] - l["top"] <= 4
                    for l in short_h)
        return below and above

    # body rows
    body, footer = [], {}
    km_xs: list[float] = []
    for i in range(body_start, len(bands)):
        y0, y1 = bands[i]
        lw = band_words(y0, y1, L + 0.3, R - 0.3)
        u = _join_lines(lw).upper()
        if not footer and ((u.startswith("DAYS") or u.startswith("ARR")) and ("ARR" in u or "OPERATION" in u)):
            footer["days"] = i
            continue
        if "TABLE" in u and (u.startswith("TO") or u.startswith("FROM") or u.startswith("TABLE")):
            footer["table"] = i
            continue
        if footer:
            continue
        mks = [w for w in lw if w["text"] in ("a", "d")]
        lmk = [w for w in mks if lcols and abs(w["x0"] - L) < abs(w["x1"] - R)]
        rmk = [w for w in mks if w not in lmk]
        rest = [w for w in lw if w not in mks]
        alpha_x = min([w["x0"] for w in rest if re.search(r"[A-Za-z]", w["text"]) and w["text"].lower() not in KM_LABEL] or [R])
        km = None
        kmw = [w for w in rest if re.fullmatch(r"/?\d{1,4}/?", w["text"]) and w["x1"] < alpha_x]
        has_km_label = any(w["text"].lower() in KM_LABEL for w in rest)
        if len(kmw) == 1 and KM_RE.match(kmw[0]["text"]):
            km = int(kmw[0]["text"])
        elif kmw:
            km = None  # several distances printed (e.g. "323/ 456" for alternative routes)
        # a "Km" heading in the first station row is NOT a printed 0: table 2 measures from
        # Delhi, so its New Delhi row has no distance (H.Nizamuddin = 10, Bhopal = 705).
        rest = [w for w in rest if w not in kmw and w["text"].lower() not in KM_LABEL]
        if rest and km is None and not kmw:
            g = re.fullmatch(r"(\d{1,4})([A-Z][A-Za-z.]+)", rest[0]["text"])  # km glued to the name: "1097Tundla"
            if g:
                km = int(g.group(1))
                rest = [{**rest[0], "text": g.group(2)}] + rest[1:]
        for w in kmw:
            km_xs.append(w["x1"])
        if any(norm_time(w["text"]) for w in rest):
            pw.append(f"{tag}: times inside the station-label area at row {_join_lines(rest)!r}; row skipped")
            body.append({"band": (y0, y1), "name": "", "km": None, "skip": True, "mk": {"L": {}, "R": {}}})
            continue
        if rest and re.fullmatch(r"(?i)km\.?via", rest[0]["text"]) and len(rest) > 2:
            # "Km. via Delhi" km-column heading in the first row. Its place name is the next word, or,
            # when printed on the line below "Km.via" inside its width while the station name stands
            # beside it (18.pdf: "Km.via / Barauni" next to "Guwahati"), that word.
            h = rest[0]
            under = [w for w in rest[1:] if w["top"] > h["top"] and w["x0"] >= h["x0"] - 3 and w["x1"] <= h["x1"] + 3]
            place = under[0] if len(under) == 1 else rest[1]
            rest = [w for w in rest[1:] if w is not place]
        # leftovers of km / marker columns that did not separate cleanly
        rest = [w for w in rest if not re.fullmatch(r"(?i)(km\.?\d*|[\d$*/]+|\.?[ads])", w["text"])]
        body.append({"band": (y0, y1), "name": _join_lines(rest), "km": km,
                     "mk": {"L": {w["text"]: (w["top"] + w["bottom"]) / 2 for w in lmk},
                            "R": {w["text"]: (w["top"] + w["bottom"]) / 2 for w in rmk}}})

    # several km columns (alternative routes / origins) cannot be told apart row by row:
    # distances from such tables are not used at all
    if len(_cluster(km_xs, tol=4)) > 1:
        pw.append(f"{tag}: several km columns; km not used")
        for r in body:
            r["km"] = None
    # page footnotes below the grid: lines starting with a marker such as "*", "**", "#"
    notes = {**(_notes or {}), **_footnotes([w for w in words if w["top"] > hy[-1] + 1])}

    segs: list[Segment] = []
    for ci, c in enumerate(cols):
        x0, x1, side = c["x0"], c["x1"], c["side"]
        upward = two_dir and side == "R"
        m = TRAIN_RE.match(c["text"])

        def cell(i):
            return _join_lines(band_words(*bands[i], x0 + 0.3, x1 - 0.3)) if i is not None else ""
        nm = ""
        if name_top is not None:
            nw = [w for w in words if bands[name_top][0] - 0.5 <= (w["top"] + w["bottom"]) / 2 <= bands[tn_band - 1][1] + 0.5
                  and x0 + 0.3 <= (w["x0"] + w["x1"]) / 2 <= x1 - 0.3]
            nm = _join_lines(nw)
        top_tbl, top_days = cell(header.get("from")), cell(header.get("days"))
        bot_tbl, bot_days = cell(footer.get("table")), cell(footer.get("days"))
        seg = Segment(pdf=pdf_name, page=pno, table=table, sub=_sub, side=side, col=ci,
                      number=m.group(2) if m else c["text"], marker=",".join(_markers(m.group(1), m.group(3))) if m else "",
                      name=nm, classes_raw=cell(header.get("class")),
                      from_table=bot_tbl if upward else top_tbl, to_table=top_tbl if upward else bot_tbl,
                      days_raw=bot_days if upward else top_days, arr_days_raw=top_days if upward else bot_days,
                      stops=[])
        if not m:
            seg.bad = True
            seg.warnings.append(f"unparseable train number cell {c['text']!r}")
            if SHARED_RE.match(c["text"]):
                seg.shared = [[x.group(1), ",".join(_markers(x.group(2)))]
                              for x in re.finditer(rf"(\d{{5}})({MARK}*)", c["text"])]
        stops: list[Stop] = []
        pending: list = []      # words of a text-only cell continuing into the next row(s)
        for ri in range(len(body)):  # always top-down so cell notes attach to the times below them
            r = body[ri]
            if r.get("skip"):
                pending = []
                continue
            cw = band_words(*r["band"], x0 + 0.3, x1 - 0.3)
            times = [w for w in cw if norm_time(w["text"])]
            other = [w for w in cw if w not in times and not DOTS_RE.match(w["text"])]
            if not times:
                if other:
                    pending.extend(other)
                    if len(pending) > 12:
                        seg.warnings.append(f"long cell note {_join_lines(pending)!r} ignored")
                        pending = []
                continue  # blank, or "..." (no halt / time not shown): not emitted
            if pending:
                other = pending + other
                pending = []
            st = _cell_stop(seg, r, side, upward, times, other, is_boxed)
            if st and not st.name.strip():
                seg.warnings.append("time in a row without a station name; stop dropped")
                st = None
            if st:
                stops.append(st)
        if pending:
            seg.warnings.append(f"cell note {_join_lines(pending)!r} without times; ignored")
        seg.stops = stops[::-1] if upward else stops
        used = set(seg.marker.split(",")) | {mk for _, ms in (seg.shared or []) for mk in ms.split(",")} | \
            {f.split(":", 1)[1].lstrip("0123456789.:") for st in stops for f in st.flags if f.startswith("footnote:")}
        seg.footnotes = {k: v for k, v in notes.items() if k in used}
        seg.monsoon = monsoon
        seg.season = season
        segs.append(seg)
    # a/d markers are unreliable on a page side when two-time cells contradict them
    for side in ("L", "R"):
        ss = [st for sg in segs if sg.side == side for st in sg.stops]
        bad = sum("markers_contradict" in st.flags for st in ss)
        good = sum("markers_agree" in st.flags for st in ss)
        if bad and bad >= good:
            pw.append(f"{tag}: a/d markers on side {side} contradict time order ({bad} vs {good}); single times there are of unknown role")
            for st in ss:
                if "single_by_marker" in st.flags:
                    st.flags.append("single_role_unknown")
    return segs, pw


def _cell_stop(seg, r, side, upward, times, other, is_boxed):
    name = r["name"]
    km = r["km"]
    flags = []
    forced = None
    if other:
        txt = _join_lines(other)
        m_ad = re.search(r"\s*\b(Arr|Dep|arr|dep)\b\.?$", txt)
        if m_ad:
            forced = m_ad.group(1).lower()
            txt = txt[:m_ad.start()].strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z .()'\-]*[A-Za-z.)]", txt) or \
                re.search(r"\b(via|from|to|table|see|runs?|days?|only|except|and|or|on)\b", txt, re.I) or \
                len(txt) > 40:
            seg.warnings.append(f"row {name!r}: unparsed cell text {txt!r}; stop dropped")
            return None
        name, km = txt, None
        flags.append("inset")
    ts = sorted(times, key=lambda w: w["top"])
    if upward:
        ts = ts[::-1]
    for w in ts:
        if re.search(r"[@*#$+^~!†]$", w["text"]):
            flags.append("footnote:" + w["text"])
    vals = [norm_time(w["text"]) for w in ts]
    boxed = any(is_boxed(w) for w in ts)
    arr = dep = None
    if len(ts) > 2:
        seg.warnings.append(f"row {name!r}: {len(ts)} times in one cell; stop dropped")
        return None
    if forced:
        if len(ts) != 1:
            seg.warnings.append(f"row {name!r}: Arr./Dep. note with {len(ts)} times; stop dropped")
            return None
        if forced == "arr":
            arr = vals[0]
        else:
            dep = vals[0]
        return Stop(name=name, km=km, arr=arr, dep=dep, boxed=boxed, flags=flags)
    mk = r["mk"][side] if "inset" not in flags else {}
    if len(ts) == 2:
        if abs(ts[0]["top"] - ts[1]["top"]) < 1.5:
            seg.warnings.append(f"row {name!r}: two times on one line; stop dropped")
            return None
        if "a" in mk and "d" in mk:
            ya = [abs((w["top"] + w["bottom"]) / 2 - mk["a"]) for w in ts]
            yd = [abs((w["top"] + w["bottom"]) / 2 - mk["d"]) for w in ts]
            if yd[0] < ya[0] and ya[1] < yd[1]:
                flags.append("markers_contradict")
            elif ya[0] < yd[0] and yd[1] < ya[1]:
                flags.append("markers_agree")
        arr, dep = vals  # two stacked times: the first in reading order (= earlier) is the arrival
        return Stop(name=name, km=km, arr=arr, dep=dep, boxed=boxed, flags=flags)
    t = ts[0]
    ty = (t["top"] + t["bottom"]) / 2
    if "a" in mk and "d" in mk:
        da, dd = abs(ty - mk["a"]), abs(ty - mk["d"])
        if abs(da - dd) < 1.5:
            flags.append("single_centered")
            dep = vals[0]
        elif da < dd:
            arr = vals[0]
            flags.append("single_by_marker")
        else:
            dep = vals[0]
            flags.append("single_by_marker")
    elif "a" in mk:
        arr = vals[0]
        flags.append("single_a_only")
    elif "d" in mk:
        dep = vals[0]
        flags.append("single_d_only")
    else:
        flags.append("single_unmarked")
        dep = vals[0]
    return Stop(name=name, km=km, arr=arr, dep=dep, boxed=boxed, flags=flags)


def parse_pdf(path: str) -> tuple[list[dict], list[str], dict]:
    name = os.path.basename(path)
    out, warns = [], []
    info = {"pages": 0, "timetable_pages": 0}
    with pdfplumber.open(path) as pdf:
        info["pages"] = len(pdf.pages)
        for i, page in enumerate(pdf.pages, 1):
            try:
                segs, w = parse_page(name, i, page)
            except Exception as e:  # reported, never silently skipped
                warns.append(f"{name} p{i}: parser error {e!r}")
                continue
            if segs:
                info["timetable_pages"] += 1
            out.extend(asdict(s) for s in segs)
            warns.extend(w)
    return out, warns, info


if __name__ == "__main__":
    import json
    segs, warns, info = parse_pdf(sys.argv[1])
    print(json.dumps({"info": info, "warnings": warns, "segments": segs}, indent=1))
