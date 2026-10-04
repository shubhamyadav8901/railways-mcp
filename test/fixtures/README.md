# Test fixtures

All fixtures in this directory are **synthetic**. They were written by hand to
match the upstream formats that the adapters in `src/providers/unofficial/`
parse (field names, delimiters, nesting, inline-JS shapes, table headers), and
contain only the structure those parsers read.

They contain no copied third-party content. Every value (times, delays,
durations, distances, availability statuses, fares, cache timestamps,
coordinates, CSRF token names/values, internal ids) is invented. Train numbers
and station codes are public identifiers, kept so the tests read naturally.
