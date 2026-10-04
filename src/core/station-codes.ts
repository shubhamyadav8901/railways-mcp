import { existsSync, readFileSync } from "node:fs";

/**
 * Station code equivalences: codes that name the same physical station
 * (renamed or recoded stations, e.g. BSBS → BNRS). Built and verified
 * offline (data/station_equivalences.json; each group needs two independent
 * pieces of evidence). Every code is mapped to the code current sources use,
 * so a station isn't treated as two different places, or reported as a
 * conflict, just because sources use different codes for it.
 */
export interface EquivalenceFile {
  meta?: Record<string, unknown>;
  groups: Array<{ codes: string[]; current: string; names?: string[]; evidence?: string[] }>;
}

export class StationCodes {
  private readonly toCurrent = new Map<string, string>();
  private readonly members = new Map<string, string[]>();

  constructor(groups: EquivalenceFile["groups"] = []) {
    for (const g of groups) {
      const current = g.current.toUpperCase();
      const codes = [...new Set([current, ...g.codes.map((c) => c.toUpperCase())])];
      if (!g.codes.map((c) => c.toUpperCase()).includes(current)) {
        throw new Error(`station equivalence group ${codes.join("/")}: current code ${current} is not one of its codes`);
      }
      for (const c of codes) {
        const prev = this.toCurrent.get(c);
        if (prev && prev !== current) throw new Error(`station code ${c} is in two equivalence groups (${prev}, ${current})`);
        this.toCurrent.set(c, current);
      }
      this.members.set(current, codes);
    }
  }

  static fromFile(path: string): StationCodes {
    if (!existsSync(path)) return new StationCodes();
    return new StationCodes((JSON.parse(readFileSync(path, "utf8")) as EquivalenceFile).groups);
  }

  /** The code current sources use for this station (the code itself when it has no known aliases). */
  current(code: string): string {
    const c = code.toUpperCase();
    return this.toCurrent.get(c) ?? c;
  }

  /** All codes known for the same station, current first. */
  aliases(code: string): string[] {
    return this.members.get(this.current(code)) ?? [code.toUpperCase()];
  }

  same(a: string, b: string): boolean {
    return this.current(a) === this.current(b);
  }

  get size(): number {
    return this.members.size;
  }
}
