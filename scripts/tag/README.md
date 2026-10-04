# TAG 2026 timetable ETL

Builds `data/tag2026.json.gz` (format: `src/providers/timetable/format.ts`) from the Railway Board's
*Trains at a Glance 2026* PDFs. Offline and deterministic once the PDFs are downloaded.
Accuracy comes first: when the PDF is ambiguous, the value is null or the stop/train is dropped,
and a warning is recorded. Nothing is filled in from other sources.

## Run

```sh
pip install -r scripts/tag/requirements.txt          # Python 3.13
python3 scripts/tag/download.py                      # 1.pdf, 2.pdf, ... until 404 -> data/raw/tag2026/ (0.5 s apart)
python3 scripts/tag/build.py                         # parse + merge -> data/tag2026.json.gz (~2 min, 8 processes)
python3 scripts/tag/build_equivalences.py --erail-cache <dir> --ct-cache <dir>   # -> data/station_equivalences.json (<=150 new ConfirmTkt calls, 2 s apart)
python3 scripts/tag/build.py                         # again: ambiguous names may use the verified equivalences
python3 scripts/tag/validate.py --cache <dir>        # coverage, consistency, eRail spot-check (QA only)
```

Per-PDF parse results are cached in `data/raw/tag2026/parsed/<parser-hash>/`; `build_report.json`
there lists page warnings. `excluded_trains.csv` (written by `build.py`) lists every excluded train and why.
`download.py` uses `curl` because the server's TLS handshake fails with Python's OpenSSL defaults.

## Files

| file | role |
|---|---|
| `parse_pdf.py` | one PDF -> per-table train columns ("segments") |
| `stations.py` + `station_aliases.csv` + `station_ambiguous.csv` | TAG name -> station code (or candidate codes) |
| `build_equivalences.py` | verified same-station code groups -> `data/station_equivalences.json` |
| `build.py` | split/merge segments per train, days, classes, output |
| `validate.py` | the checks below |

## How the parser works

* `page.dedupe_chars()` removes the doubled glyphs; words are extracted with `y_tolerance=1` so the
  stacked a/d lines (and multi-line class cells) stay apart. Rotated margin text is dropped.
* Rows come from horizontal rules in the station-name area. Train columns come from vertical rules
  (lines or zero-width rectangles); cell-rectangle edges are a fallback. Pages holding several tables
  are cut into one region per "Train Number" label.
* Two-direction tables (stations in the middle) are supported: left columns read downward, right
  columns read upward, with their own a/d markers and From/To and Days rows.
* Two stacked times in a cell are arrival then departure in reading order. A single time takes its role
  from the a/d marker of its line. A single time centred between a/d lines, in a row with no marker, or on a
  page whose markers contradict the time order is ambiguous. It is kept only when it is the first stop
  (departure) or a boxed last stop (arrival). Otherwise the stop is **omitted** and a warning is recorded.
* `...` (no halt / time not shown) is not emitted. Notes inside a cell ("Khajuraho Arr. 12.55",
  "DLI 09.50 10.05") become stops at that station. Other cell text is dropped with a warning.
* Boxed times mark where a train starts or ends inside a table. Page footnotes (`*`, `**`, `#`, `†`, ...) are attached
  to the trains that carry the marker, verbatim (e.g. renumbering or fog cancellations).
  On a page holding several tables, notes printed below a table (outside its grid) are read too: a marker defined
  once on the page applies to every table, a marker defined under several tables only to the table above it.
* Konkan "MONSOON" pages are parsed. Each page's validity window is read from its title, "Monsoon Timings : 10th
  June to 31st October", which gives `{"from": "06-10", "to": "10-31"}`. A page without a readable window is skipped
  with a warning.

## Merging a train across tables

1. Each column is cut into internally consistent pieces at boxed start/end times and wherever two consecutive
   times are more than 12 h apart. TAG sometimes prints onward rows out of route order, e.g. a reversal at
   Bikaner listed below Jodhpur. A junction row repeated with the same times (e.g. Khurda Road around Puri)
   is kept once.
2. Pieces are anchored to each other through shared stations. Each shared arrival/departure proposes a time
   offset, and the majority wins. A junction where one table has only the arrival and the other only the
   departure anchors only when the halt is 3 h or less. If tables print different times for a stop, that
   time is set to null with a warning.
3. Stops are ordered by elapsed time. Each stop's printed clock time must equal the origin time plus the elapsed
   minutes, and consecutive stops must be no more than 12 h apart. No station may appear twice. Any
   violation **excludes the train**.
4. Pieces that share no station are chained only through TAG's own linkage. A piece can follow another
   when a "From Table No." or "To Table No. / via" cell of one names the other's table, the first piece
   does not end its run, the second does not start one, the clock gap is between 0 and 12 h, and there is
   exactly one candidate. These joins carry a warning. Pieces that still cannot be placed are dropped with
   a warning, and if they hold the larger part of the route the train is excluded.
   A single time at the first or last stop counts as the origin departure or terminal arrival only when two
   of three signals agree: the time is boxed, its a/d role is ambiguous, the train name names that
   station. The name is only a check and never a source of stops. Day numbers need a boxed origin, or an
   ambiguous one named in the train name with no "From Table" cell.
5. `day` is the day of *arrival* (of departure at the origin): 1 at the origin, +1 whenever the clock goes backwards. It is only given when the first stop
   is a confirmed origin (see 4). Otherwise `day` is null and a warning is recorded.

## Seasonal (monsoon) variants

A train with monsoon pages appears twice with the same `n`:
* The **monsoon variant** has `valid` set to the window printed on its pages. It is built from the monsoon pages plus
  any regular-table segment that shares a station with them and prints identical times at every shared station. A
  warning says which parts came from regular tables.
* The **regular variant** has `valid` set to the complementary window (`11-01` to `06-09`) and is built from the
  regular pages.

Each variant goes through the full merge and passes every invariant on its own. If the monsoon variant fails, only the
regular one remains. It keeps the complementary window and carries the warning "valid only outside the monsoon window".
If the regular variant fails, the monsoon variant stands alone with its window and carries the warning "valid only
inside the monsoon window".

The monsoon variant has one more check: every time it publishes at a station that the monsoon pages list must be a time
those pages print there. Shared stations are compared as sets of printed times, because a single time may sit in
different a/d roles in different tables. If a regular time stands in, the monsoon variant is dropped. `build_report.json`
records each dropped variant and its reason under `seasonal_variant_dropped`. Trains without monsoon pages keep a
single entry with no `valid`.

## Field notes / known limitations

* **km and dist are always null.** TAG km columns are per table and measured from the table's own
  baseline. Table 2 starts at Delhi, so New Delhi has no km and Bhopal is 705. Some tables print two km
  columns, and branch rows break monotonicity. A check against eRail found errors up to ~100 km, so no
  distance is published.
* **classes** are exactly what TAG prints, mapped to 1A 2A 3A 3E SL CC EC 2S FC (`3A(E)`/`3AE` -> 3E).
  `II` (general second class) is not mapped to 2S: TAG uses `II` for unreserved general coaches and prints
  `2S` separately when reserved second sitting exists. `P` (pantry), `EV`, `EA` and `GEN` are not
  classes in the list. Class text that does not tokenise cleanly gives `classes: null`. Coaches added after
  TAG went to press (3E, 1A) are not reflected.
* **Station codes**: exact normalised match against the datameet 2016 list (case, punctuation,
  Jn/Junction, Cantt, (T)/Terminus, Rd, Pt., spacing). Only a single-candidate match is used, plus
  `station_aliases.csv` for renamed stations and codes (DDU, PRYJ, RKMP, VGLJ, NDPM, CSMT, MMCT, SMVB,
  ...). State, zone, lat and lon come from datameet (old code for renamed stations). Ambiguous names (e.g. `Dadar` = DR or DDR,
  `Lucknow/ Lucknow Jn.`) stay null.
* **Ambiguous names** (several datameet stations with the same normalised name, or curated in
  `station_ambiguous.csv`, e.g. Rajendranagar = RJQ Indore / RJPB Patna) get their code from route geography.
  The candidate's detour between the train's neighbouring coded stops must be at most half the direct distance
  plus 30 km, and at least 100 km better than every other candidate. With one neighbour, the nearest must be
  within 400 km, at least 3x closer and at least 100 km closer. If every candidate is in one verified
  equivalence group, the group's current code is used. Same-place stations on different lines (Dadar DR Central /
  DDR Western) are then placed by line: with coded stops on both sides, a candidate is chosen when at least 3
  datameet 2016 routes serve it between those two stops and none serves any other candidate there, every other
  candidate is served by some 2016 route, no other candidate sits at the same point (Phalodi PLC/PLCJ: one station,
  two codes), and known zones agree. Otherwise code=null. Of 324 ambiguous stops: 40 resolved by geography (all
  Rajendranagar -> RJPB), 7 by equivalence (New Jalpaiguri Jn. -> NJP, Velankanni -> VLNK), 124 by line (Dadar DR 100,
  DDR 2, Lal Kuan LKU 13, Alipurduar APDJ 5, Aishbagh ASH 3, Govindpuri GOY 1; 116/116 verifiable against eRail routes
  correct, 8 terminal-adjacent Dadar stops not on eRail's current route), 153 left null (Sabarmati SBI/SBT, terminal
  Dadar, Kalol KLL/KLLF, Dhaulpur DHO/DHOA, ...).
* **Station equivalences** (`data/station_equivalences.json`, built by `build_equivalences.py`). TAG codes are not
  rewritten; consumers canonicalise with the table. There are three candidate sources:
  * TAG-vs-eRail route position with identical times.
  * datameet near-duplicates.
  * Retired datameet codes: not in TAG, close to a TAG station, a datameet train terminal searched by name on
    ConfirmTkt, or a datameet-2016 vs eRail stop at the same position (terminal or single-stop slot) of the same
    train number.

  A pair needs two independent pieces of evidence. Route evidence counts once per pair, and not at all if the TAG
  code came from our alias table. Coordinates must be within 1 km, taken from datameet's own entry for the old code
  and ConfirmTkt for the new one. Names must match after normalisation. Names that only contain each other are
  rejected and listed as doubtful.

  Rejection rules:
  * Pairs more than 5 km apart are rejected.
  * Both codes live on ConfirmTkt means reject, with one exception for legacy entries ConfirmTkt still lists
    (BCT, CSTM). The exception needs datameet-vs-eRail route evidence and ConfirmTkt giving both codes the same
    name, or route evidence from at least 2 train pairs. This keeps out distinct neighbours such as Dadar DR/DDR
    and Lucknow LJN/LKO.

  A code's "not live on ConfirmTkt" status counts only when proven. The autosuggest list is cut at 15 rows, so an
  absent code is re-checked by a name search whose list is not full. Otherwise the status is unknown and the pair
  is rejected.

  Result: 19 groups, including BCT/MMCT, CSTM/CSMT, ALD/PRYJ, HBJ/RKMP, AWB/CPSN, KCVL/TVCN and MUV/BNRS.
  Some groups are left out for lack of proof:
  * TAG's BSBS (BNRS), MGS/DDU, HBD/NDPM and FD/AYC have only one independent source.
  * JHS/VGLJ, PBH/MBDP, BTKL/BTJL, MKI/BMKI, GMZ/GUZ and KRHR/KARR have an unproven ConfirmTkt status.
* TAG lists the main halts of a train, not every halt, so about 46% of the halts eRail lists are absent.
* Layouts not parsed (their trains appear only if other tables carry them): 47/48.pdf lower table,
  81.pdf p4, 88/89.pdf right table, 94-97.pdf tables 2-3. (26.pdf monsoon pages are parsed into seasonal variants.)
* Shared columns: TAG prints several numbers over one column ("12888/12896") when their timings are identical, with the
  running days of each number separated by "/" in the Days cell. One entry per number is built only when nothing in
  the column is specific to one number (no marked time or cell note, boxed times only at the column ends, number
  footnotes silent on halts/route) and the Days cell splits into one group per number. The split days are used only
  when a number's own column elsewhere confirms them; TAG once prints them in the opposite order ("15630/15930" over
  "M / F"), so unconfirmed days are null. The name is left empty unless another table names the train.
* Excluded trains (see `excluded_trains.csv`, 197 in total): 18 share a column with another number (e.g. `12330/12380`);
  114 have route pieces whose order can't be determined (no shared station, no unique placement from TAG's linkage, or two stations with the same time);
  61 have inconsistent tables (times going backwards or jumping, or tables disagreeing on the route); 4 have fewer than 2 usable stops.
  Published trains that still miss a piece say so in a "stop(s) omitted" warning.
* `data_as_of` is "2026": the PDFs print no single validity date, only per-train "w.e.f." footnotes, so only the year is stated.

## Validation (`python3 scripts/tag/validate.py --sample 120`)

Final run. The sample is 28 fixed trains of the requested kinds (Rajdhani 12951/12301/12309/12424,
Vande Bharat 22436/20171, Shatabdi 12002, multi-table 12627/12628/12295/12371, weekly 12162/22455,
MEMU 11605, Gatimaan 12050, ...) plus 120 drawn by a hash of the train number, so the draw is stable
across rebuilds. Seasonal trains are compared using the entry in force on the run date.

```
== 1. Coverage
trains parsed: 3561
stops parsed: 41383
stops with station code: 39727 (96.0%)
== 2. Internal consistency
trains with seasonal variants: 103 (91 with both a monsoon and a regular entry, 12 with one windowed entry)
trains with monotonic times after day rollover (no step back, no >12 h gap): 3561/3561 (100.0%)
first stop is a real origin (departure only): 3471/3561 (97.5%)
last stop is a real destination (arrival only): 3311/3561 (93.0%)
both terminals present: 3228/3561 (90.6%)
trains with < 2 stops: 0;  duplicate train numbers (other than non-overlapping seasonal variants): 0;  format errors: 0
== 3. External spot-check vs eRail (QA only)
trains compared: 150 (sample 150, not on eRail 0)
TAG stops (with code) found on eRail route: 1546/1568 (98.6%)
times (arr/dep) equal to eRail: 2090/2396 (87.2%)
day numbers equal to eRail: 1461/1462 (99.9%)
running days equal to eRail: 145/147 (98.6%)
origin and destination equal to eRail's (modulo station_equivalences.json): 116/150 (77.3%); exact codes: 115/150
== 4. Seasonal (Konkan monsoon) variants vs eRail (run on 10-04, inside the monsoon window)
monsoon variants (valid today: True): 96 trains, times equal to eRail 1584/1837 (86.2%)
regular variants (valid today: False): 98 trains, times equal to eRail 1114/2249 (49.5%)
```

On the same 149 trains as the previous run, times are unchanged (2045/2330). The lower overall rate comes from one newly published train in the sample, 15909, whose 21 mismatches are a uniform +20 min: TAG itself prints these times (e.g. Dibrugarh 10.20), while current running is 20 minutes earlier. That is a retiming, which the server's majority rule corrects when current sources agree.

Most terminal mismatches are trains re-terminated since TAG (SBC->SMVB, HWH->SRC), codes renamed or
unmatched (e.g. Kolkata CP vs KOAA), or a piece TAG's linkage could not place. A separate check of 39 trains
joined by table linkage against eRail found station order correct in 39/39 and day numbers equal at
613/615 stops. Before the terminal fix, only 39.0% of trains ended at an arrival-only stop and 35.8% of
sampled origin/destination pairs matched eRail. The cause was a boxed terminal time printed on a "d" line,
which split the terminal off as a separate run.

A visual audit of 14 random time mismatches against PDF crops found the parsed value equal to what
TAG prints in all 14 (e.g. 15001 Moradabad 09.40, 11605 Vidisha 15.20, 12716 Bhopal 22.40). The differences
are retimings made after TAG 2026 went to press, plus a few TAG typos. Class differences are coaches
added since TAG and eRail's 2S quota.
