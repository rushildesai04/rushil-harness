/**
 * Version pinning and runtime preconditions for the pi runtime.
 *
 * pi ships breaking changes on a fast cadence (0.73 -> 0.84 in roughly three
 * months). The pin lives here and nowhere else, and the contract tests in
 * tests/contract.test.ts assert the API shape we actually depend on so an
 * upgrade fails loudly in CI instead of silently at runtime.
 */

/** Exact pi version this adapter is written against. */
export const PI_VERSION = "0.84.2";

/** Minimum Node version pi itself requires (its package.json engines field). */
export const REQUIRED_NODE = "22.19.0";

function parseSemver(value: string): [number, number, number] {
  const core = value.replace(/^v/, "").split("-")[0] ?? "";
  const parts = core.split(".");
  return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
}

function gte(a: string, b: string): boolean {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return true;
    if (l < r) return false;
  }
  return true;
}

export interface NodeVersionCheck {
  ok: boolean;
  current: string;
  required: string;
  message?: string;
}

/**
 * pi uses import attributes (`with { type: "json" }`), which Node 20.9 cannot
 * parse. The failure mode is a raw SyntaxError from deep inside pi's provider
 * loader, which is hard to diagnose — so we check up front.
 */
export function checkNodeVersion(current: string = process.versions.node): NodeVersionCheck {
  const ok = gte(current, REQUIRED_NODE);
  return {
    ok,
    current,
    required: REQUIRED_NODE,
    message: ok
      ? undefined
      : `Node ${current} is too old for pi ${PI_VERSION} (requires >=${REQUIRED_NODE}). ` +
        `Run \`nvm use\` in the repo root — .nvmrc pins a supported version.`,
  };
}

export function assertNodeVersion(): void {
  const check = checkNodeVersion();
  if (!check.ok) throw new Error(check.message);
}
