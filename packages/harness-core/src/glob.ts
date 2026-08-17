import picomatch from "picomatch";

/** Compile a glob list once; matching runs per changed file on every attempt. */
export function globMatcher(patterns: string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const isMatch = picomatch(patterns, { dot: true });
  return (path: string) => isMatch(path);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return globMatcher(patterns)(path);
}
