/**
 * POSIX single-quote shell quoting (BR-P08-008). Values interpolated into a
 * sandboxed command line may contain single quotes / spaces / shell
 * metacharacters (e.g. wiki ingest URLs with `?` and `&`); naive
 * interpolation would let them break out of the quoting.
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
