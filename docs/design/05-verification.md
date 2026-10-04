# Cross-source verification

[← Design index](../README.md) · [← Request flow and providers](04-request-flow.md) · [Punctuality history →](06-punctuality.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## `find_trains_between` with cross-source verification

```mermaid
sequenceDiagram
  autonumber
  participant L as LLM
  participant T as find_trains_between
  participant R as ProviderRegistry
  participant TAG as tag2026 (local)
  participant V as Verifier (budget 20 s)
  participant CT as ConfirmTkt
  participant ER as eRail
  L->>T: from, to, date?, filters
  T->>T: requireStation(from), requireStation(to)
  T->>R: first("trains_between")
  R->>TAG: trainsBetween(q)
  TAG-->>R: Leg[] (indexed, in-memory)
  R-->>T: primary answer + provenance
  par other current sources, each bounded by the budget
    T->>V: gather(ConfirmTkt)
    V->>CT: trainsBetween(q) [rate limit 1/s, cache 5 min]
    CT-->>V: Leg[] or RailError
  and
    T->>V: gather(eRail)
    V->>ER: trainsBetween(q) [rate limit 1/s, cache 30 min]
    ER-->>V: Leg[] or RailError
  end
  V-->>T: views + unavailable (timeouts → "not checked")
  T->>T: mergeTrainsBetween(): one row per train visit,<br/>presented by highest-priority source listing it
  T->>T: compareLegs(): departure, arrival, departs_on, classes, distance
  T->>T: apply filters, sort, cap
  T-->>L: trains[] each with verification, source, cross_checked_with
```

---

## Station code equivalence

Some stations have several codes because they were renamed or recoded, e.g. NJPS → NJP. `StationCodes` (`src/core/station-codes.ts`) maps every code in a verified equivalence group (`data/station_equivalences.json`) to the code current sources use. It is applied at four points:
- **Tool inputs:** `requireStation` returns the current code.
- **Local datasets at load:** station rows merge under the current code. The current code's own row wins, gaps are filled from alias rows, and every name stays searchable.
- **Remote source queries:** sources are always asked with the current code.
- **Before comparing:** `canonSchedule` / `canonLeg` / DelayHistory station codes.

So one station under two codes is never treated as two stations or reported as a conflict. A group is only accepted with two independent pieces of evidence (see [Offline data pipelines](08-data-pipelines.md#station-code-equivalences)).

```mermaid
flowchart LR
  IN[/station code from tool input or any source/] --> Q{code in an<br/>equivalence group?}
  Q -- No --> SAME([use as is])
  Q -- Yes --> CUR([group's current code])
```

---

## Seasonal timings

Some trains, mainly on the Konkan route, run to different timings in the monsoon. They appear once per yearly window (`valid: {from, to}` as MM-DD). Each request resolves "today" in IST once, and the variant valid on the travel date (or today) is the one served. eRail and ConfirmTkt only publish the timings in force today, so timings for another season can't be confirmed or refuted by them:

```mermaid
flowchart TD
  A([primary schedule or leg]) --> B{has a seasonal<br/>valid window?}
  B -- No --> C([cross-check as usual])
  B -- Yes --> D{today in IST<br/>inside the window?}
  D -- Yes --> C
  D -- No --> E([not_checked: other sources only publish<br/>today's timings; no upstream calls])
```

---

## Verification status decision (`Comparison`)

Each compared **field** is classified first; the item's overall status then follows.

```mermaid
flowchart TD
  F([field values from sources]) --> F1{Any value<br/>reported?}
  F1 -- No --> F0([field ignored])
  F1 -- Yes --> F2{Every pair of values<br/>agrees? *}
  F2 -- Yes --> F3{≥ 2 distinct upstreams<br/>among evidence sources? **}
  F3 -- Yes --> FOK([field = confirmed])
  F3 -- No --> FS([field = single_source])
  F2 -- No --> M{One value backed by ≥ 2 distinct upstreams,<br/>more than any other value?}
  M -- Yes --> FM([field = majority])
  M -- No --> U{Primary stands alone against ≥ 2 agreeing services<br/>sharing one upstream that isn't the primary's,<br/>and no rival group of ≥ 2?}
  U -- Yes --> FU([field = updated: their value is shown<br/>as the current running timetable])
  U -- No --> MR{presentOperational, and the primary plus ≥ 1 more service<br/>on its upstream agree, none on it dissents,<br/>and exactly one other value backed by one other upstream?}
  MR -- Yes --> FMR([field = updated: the primary's value stays,<br/>the other under majority.differs])
  MR -- No --> FC([field = conflict<br/>each source's value listed])
```

A settled value that replaces the primary's is recorded under `corrections` with its `basis` (`majority` or `updated`, the latter naming the `shared_upstream`). It can only be shown where the caller can apply it; otherwise the field stays a conflict.

**The mirror rule (`PRIMARY_SOURCE=confirmtkt`).** With ConfirmTkt presented first, the verifier sets `presentOperational`. `updated` then also covers the mirror case: the primary (an evidence source) and at least one other service share its upstream and agree, no service on that upstream reports anything else, and exactly one other value differs, backed by exactly one other upstream (in practice the printed timetable). The primary's value is already the one shown, so no correction is recorded and `applyCorrections` changes nothing. The conflict entry carries `majority: { value, sources, basis: "updated", shared_upstream, differs: [{ source, value }] }`, where `differs` discloses the printed value. It is still not independent confirmation: `confirmed` always needs two distinct upstreams. ConfirmTkt alone against the printed timetable, a dissenting operational service, or two other values stay `conflict`. When independent upstreams outvote ConfirmTkt (e.g. the official timetable and the archive on a station field), the ordinary majority rule applies and the correction replaces ConfirmTkt's value. Without the setting the rule is off.

\* Equality is exact for times, days and codes, set equality for running days and classes, ±2 km for distance, ≤1 km for coordinates. Comparison ignores key order.
\*\* Evidence is counted by **upstream** (`ProviderInfo.upstream`): eRail, ConfirmTkt, RailRadar, etrain.info and NTES are tagged as Indian Railways' operational data and count once. **Not evidence:** the archived dataset for timetable facts; coordinates a dataset copied from another (`coordinatesIndependent` must be declared by local datasets, so this fails closed); a second identical coordinate pair.

```mermaid
flowchart TD
  A([All fields compared]) --> B{Any unresolved conflict<br/>or contradiction?}
  B -- Yes --> X([conflict])
  B -- No --> C{No evidence source, or<br/>nothing comparable?}
  C -- Yes --> NC([not_checked])
  C -- No --> UP{Any field updated?}
  UP -- Yes --> UPD([updated])
  UP -- No --> D{No field confirmed by<br/>two independent upstreams?}
  D -- Yes --> SS{A source couldn't be checked<br/>budget or other season?}
  SS -- Yes --> NC
  SS -- No --> S([single_source])
  D -- No --> E{Any single-upstream<br/>fields?}
  E -- Yes --> P([partially_confirmed])
  E -- No --> MJ{Any majority<br/>fields?}
  MJ -- Yes --> MAJ([majority])
  MJ -- No --> OK([confirmed])
```

**Source independence.** eRail, ConfirmTkt and RailRadar are separate services, but they very likely draw on the same Indian Railways operational data (NTES/CRIS). RailRadar's schedules matched eRail's on 628 of 628 stop times checked. Their agreement against TAG therefore shows the current running timetable (usually a retiming since TAG was printed), not two independent measurements. That is the right value to show a traveller, and the TAG original is always disclosed.

**Applying settled values.** When a field is settled, the settled value is the one shown. That happens either as `majority` (two or more independent upstreams agree) or as `updated` (the operational-data services agree unanimously against the printed timetable, typically a retiming). Schedules, trains-between results and station-board rows show it, with durations and halts recalculated. The original value is listed under `verification.corrections` with its `basis`. Connection search plans on the primary timetable, because layovers depend on it; it only lists corrections on each leg, so a leg can show `updated` while still displaying the printed value. Contradictions, such as a source that doesn't list the train at all, are never settled.

A **contradiction** is a source that answered but does not list the train (`listed: false`) or the halt. Parts can't be better verified than their whole: stop statuses are capped by the schedule's status, and a journey takes its weakest leg.

---

## Budgeted fan-out (`Verifier.map` / `bounded`)

```mermaid
flowchart LR
  S([items to verify]) --> W1[worker 1] & W2[worker 2]
  W1 & W2 --> Q{time left<br/>in budget?}
  Q -- No --> NC[item = not_checked<br/>no upstream call made]
  Q -- Yes --> CALL[verify item:<br/>Promise.race call vs deadline]
  CALL --> R{finished before<br/>deadline?}
  R -- Yes --> OK[comparison result]
  R -- No --> TO[source marked<br/>'not checked: budget used up']
```

Concurrency is 2 by default, so rate-limited upstreams aren't flooded with calls that would outlive the budget. The primary answer is never subject to the verification budget.

---

[← Design index](../README.md) · [← Request flow and providers](04-request-flow.md) · [Punctuality history →](06-punctuality.md)
