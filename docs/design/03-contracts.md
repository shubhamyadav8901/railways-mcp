# Contracts and domain model

[← Design index](../README.md) · [← Architecture](02-architecture.md) · [Request flow and providers →](04-request-flow.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## Contracts (UML class diagram)

```mermaid
classDiagram
  direction LR
  class Provider {
    <<interface>>
    +info: ProviderInfo
  }
  class ProviderInfo {
    +id: string
    +kind: official_timetable | archived_dataset | commercial_api | unofficial_api | geocoder
    +capabilities: Capability[]
    +dataAsOf: string?
    +possiblyOutdated: boolean
    +coordinatesIndependent: boolean?
  }
  class StationSource { <<interface>> +searchStations(q, limit) Station[] +getStation(code) Station }
  class ScheduleSource { <<interface>> +getSchedule(n) TrainSchedule +searchTrains(q, limit) TrainSummary[] }
  class TrainsBetweenSource { <<interface>> +trainsBetween(q) Leg[] }
  class StationIndexSource { <<interface>> +callsAt(code) StationCall[] +scheduleOf(n) TrainSchedule +hasStation(code) bool }
  class PunctualitySource { <<interface>> +delayHistory(n, period) DelayHistory }
  class AvailabilitySource { <<interface>> +availability(q) SeatAvailability }
  class FareSource { <<interface>> +fare(q) Fare }
  class Geocoder { <<interface>> +geocode(place, limit) GeocodeResult[] }

  Provider <|-- StationSource
  Provider <|-- ScheduleSource
  Provider <|-- TrainsBetweenSource
  Provider <|-- StationIndexSource
  Provider <|-- PunctualitySource
  Provider <|-- AvailabilitySource
  Provider <|-- FareSource
  Provider <|-- Geocoder
  Provider --> ProviderInfo

  class LocalTimetableProvider
  class ConfirmTktProvider
  class ERailProvider
  class ETrainProvider
  class NtesProvider
  class RailRadarProvider
  class NominatimGeocoder

  StationSource <|.. LocalTimetableProvider
  ScheduleSource <|.. LocalTimetableProvider
  TrainsBetweenSource <|.. LocalTimetableProvider
  StationIndexSource <|.. LocalTimetableProvider
  StationSource <|.. ConfirmTktProvider
  ScheduleSource <|.. ConfirmTktProvider
  TrainsBetweenSource <|.. ConfirmTktProvider
  AvailabilitySource <|.. ConfirmTktProvider
  FareSource <|.. ConfirmTktProvider
  ScheduleSource <|.. ERailProvider
  TrainsBetweenSource <|.. ERailProvider
  PunctualitySource <|.. ETrainProvider
  PunctualitySource <|.. NtesProvider
  PunctualitySource <|.. RailRadarProvider
  Geocoder <|.. NominatimGeocoder

  class ProviderRegistry {
    -order: Map~Capability, Provider[]~
    +register(cap, provider)
    +first(cap, call, isMiss?) Sourced~T~
    +all(cap, call) SettledAnswer[]
  }
  class RailError {
    +code: INVALID_INPUT | NOT_FOUND | UNSUPPORTED | UPSTREAM_UNAVAILABLE | RATE_LIMITED | UPSTREAM_AUTH
    +provider: string?
    +retryAfterSeconds: number?
  }
  class Verification {
    +status: confirmed | partially_confirmed | conflict | single_source | not_checked
    +compared: string[]
    +not_counted: string[]?
    +unavailable: (source, reason)[]?
    +conflicts: (field, values)[]?
    +single_source_fields: string[]?
  }
  ProviderRegistry o-- Provider
  ProviderRegistry ..> RailError : throws combined
```

## Domain model

```mermaid
classDiagram
  direction LR
  class TrainSchedule { +number +name +type +origin_code +destination_code +running_days: Weekday[]? +classes: string[]? +distance_km? +valid: YearlyWindow? +stops: Stop[] +data_warnings: string[] }
  class Stop { +seq +station_code +station_name +arrival: ScheduledTime? +departure: ScheduledTime? +halt_minutes? +halts: bool +distance_km? }
  class ScheduledTime { +time: HH:MM IST +day: 1 = origin day }
  class Leg { +train_number +from_code +to_code +departure: ScheduledTime (day 1) +arrival: ScheduledTime (boarding-relative) +duration_minutes +overnight +departs_on: Weekday[]? +classes? +distance_km? +valid: YearlyWindow? }
  class DelayHistory { +train_number +measure +stations +runs: (date, delays[])[]? +averages: (arr, dep)[]? +period? +window_days? +window_label }
  class Provenance { +provider +kind +data_as_of +possibly_outdated +retrieved_at +notes? }
  TrainSchedule *-- Stop
  Stop --> ScheduledTime
  Leg --> ScheduledTime
```

**Response fields added by `PRIMARY_SOURCE=confirmtkt`:**
- `verification.conflicts[].majority.differs: Array<{ source, value }>` and `majority.shared_upstream`: set only by the mirror rule (see [Verification](05-verification.md)). The shown value is the primary's; `differs` lists the other value, usually the printed timetable's. There is no matching entry under `corrections`.
- `search_stations` rows: `filled_from: { field: datasetId }` when a ConfirmTkt row's null `state`, `zone` or `lat`/`lon` was filled from the local datasets (official first, then the archive). ConfirmTkt's own values are never overwritten, and verification compares the sources' own values.
- `get_data_sources`: `primary_source` (`official` or `confirmtkt`) and `presented_first` (capability → the provider whose answer is presented first). Both are always present.

**Day conventions:** schedules use **origin-relative** days (`day 1` is the day the train leaves its origin). Legs use **boarding-relative** days (departure is always `day 1`; `arrival.day 2` means the next day). `departs_on` gives the weekdays the train leaves the *boarding* station, i.e. origin running days shifted by journey day.

---

[← Design index](../README.md) · [← Architecture](02-architecture.md) · [Request flow and providers →](04-request-flow.md)
