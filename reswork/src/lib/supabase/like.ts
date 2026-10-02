// LIKE-pattern escaping for PostgREST `.ilike()` interpolations.
//
// `%` and `_` are wildcards and `\` is the escape character itself: without
// escaping, a user query containing them (e.g. "100%_match\") widens the
// match or breaks the pattern. Escape all three with a backslash so the
// interpolated `%${escapeLike(q)}%` contains-substring search stays literal.
// Single shared implementation — every ilike interpolation site must use it.
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}
