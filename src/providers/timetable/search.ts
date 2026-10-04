/** Station-name normalisation and ranking shared by local station search. */

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bjunction\b/g, "jn"],
  [/\bjn\b/g, "jn"],
  [/\bcantonment\b/g, "cantt"],
  [/\bterminus\b/g, "t"],
  [/\bterminal\b/g, "t"],
  [/\broad\b/g, "rd"],
  [/\bcity\b/g, "city"],
];

/** Lowercase, strip punctuation, collapse whitespace, unify common railway abbreviations. */
export function normaliseName(s: string): string {
  let n = s
    .toLowerCase()
    .replace(/[().,'’\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, rep] of ABBREVIATIONS) n = n.replace(re, rep);
  return n;
}

/**
 * Ranks a station against a query. `code` is the upper-cased raw query,
 * `query` its normalised form. Returns 0 for no match.
 */
export function scoreStation(code: string, query: string, stationCode: string, name: string): number {
  if (!query) return 0;
  if (stationCode === code) return 100;
  if (name === query) return 90;
  if (name.startsWith(query)) return 70;
  const words = query.split(" ");
  const nameWords = name.split(" ");
  if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) return 50;
  if (stationCode.startsWith(code) && code.length >= 2 && /^[A-Z]+$/.test(code)) return 30;
  if (name.includes(query)) return 20;
  return 0;
}
