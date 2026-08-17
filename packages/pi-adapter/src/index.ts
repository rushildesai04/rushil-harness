/**
 * The only module in this repo permitted to import from `@earendil-works/*`.
 *
 * Everything downstream imports from `@harness/pi-adapter`. When pi changes its
 * API, the blast radius is this directory plus its contract tests.
 */

export type {
  JsonAgentSessionEvent,
  ModelInfo,
  RpcClientOptions,
  RpcEventListener,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
export { RpcClient } from "@earendil-works/pi-coding-agent";
export {
  createPiSession,
  installedPiVersion,
  type PiSessionOptions,
  resolvePiCliPath,
  resolvePiPackageRoot,
} from "./client.ts";
export {
  checkModelAvailability,
  type ModelAvailability,
  missingModelIds,
} from "./preflight.ts";
export {
  assertNodeVersion,
  checkNodeVersion,
  type NodeVersionCheck,
  PI_VERSION,
  REQUIRED_NODE,
} from "./version.ts";
