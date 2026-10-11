/** Escapes every RegExp metacharacter (backslash included) so `s` matches literally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}
