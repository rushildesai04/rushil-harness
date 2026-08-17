import type { RoleConfig, RunStore } from "@harness/core";
import { createPiSession, type RpcClient } from "@harness/pi-adapter";

/**
 * Events worth persisting. Text deltas are excluded on purpose: they arrive per
 * token and would bloat the audit log by orders of magnitude while adding
 * nothing the session JSONL does not already hold.
 */
const AUDITED_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
]);

export interface WorkerOptions {
  agentId: string;
  worktree: string;
  /** Model, tool allowlist, and turn timeout for this agent's role. */
  role: RoleConfig;
  runStore: RunStore;
  /** Streamed assistant text, for CLI progress rendering. */
  onText?: (delta: string) => void;
}

/** Ceiling for process start and the first RPC round trip. */
const STARTUP_TIMEOUT_MS = 60_000;

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PromptOutcome {
  timedOut: boolean;
  lastAssistantText: string | null;
}

export class Worker {
  readonly agentId: string;
  private readonly options: WorkerOptions;
  private client: RpcClient | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.agentId = options.agentId;
    this.options = options;
  }

  async start(): Promise<void> {
    const { role, worktree, runStore, agentId } = this.options;

    const client = createPiSession({
      cwd: worktree,
      provider: role.model.provider,
      ...(role.model.id ? { model: role.model.id } : {}),
      thinking: role.model.thinking,
      tools: role.tools,
      sessionPath: runStore.sessionPath(agentId),
      sessionName: `${runStore.runId}/${agentId}`,
      // A task repo must not be able to inject extensions into the agent
      // working on it.
      isolateProjectResources: true,
    });

    this.unsubscribe = client.onEvent((event) => {
      const record = event as unknown as Record<string, unknown>;
      const type = String(record.type ?? "");

      if (type === "message_update") {
        const inner = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === "text_delta" && inner.delta) this.options.onText?.(inner.delta);
        return;
      }
      if (!AUDITED_EVENTS.has(type)) return;

      runStore.emit(`agent:${type}`, {
        agentId,
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        isError: record.isError,
      });
    });

    // A pi process that comes up wedged would otherwise be discovered only when
    // the first prompt burns the whole turn timeout, so probe it immediately.
    await withTimeout(client.start(), STARTUP_TIMEOUT_MS, `${agentId}: pi failed to start`);
    await withTimeout(client.getState(), STARTUP_TIMEOUT_MS, `${agentId}: pi did not respond`);
    // Transient provider errors (429/5xx) are common with subscription auth and
    // concurrent workers; let pi absorb them rather than failing the run.
    await client.setAutoRetry(true);
    this.client = client;

    runStore.emit("worker:start", {
      agentId,
      worktree,
      model: role.model.id ?? "(provider default)",
      thinking: role.model.thinking,
      tools: role.tools,
    });
  }

  /** Send a prompt and wait for the agent to fully settle. */
  async send(message: string, timeoutMs: number): Promise<PromptOutcome> {
    const client = this.requireClient();
    this.options.runStore.emit("worker:prompt", {
      agentId: this.agentId,
      chars: message.length,
    });

    try {
      await client.prompt(message);
      await client.waitForIdle(timeoutMs);
    } catch (error) {
      await client.abort().catch(() => undefined);
      this.options.runStore.emit("worker:prompt-timeout", {
        agentId: this.agentId,
        timeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return { timedOut: true, lastAssistantText: null };
    }

    const lastAssistantText = await client.getLastAssistantText().catch(() => null);
    return { timedOut: false, lastAssistantText };
  }

  async stats(): Promise<{ costUsd?: number; inputTokens?: number; outputTokens?: number }> {
    const client = this.client;
    if (!client) return {};
    try {
      const raw = await client.getSessionStats();
      // Read defensively so a field rename in a pi upgrade degrades the cost
      // report rather than failing the run. `cost` is the one that matters:
      // the pipeline's budget ceiling is enforced from it.
      const tokens = (raw as { tokens?: { input?: number; output?: number } }).tokens;
      return {
        costUsd: typeof raw.cost === "number" ? raw.cost : undefined,
        inputTokens: typeof tokens?.input === "number" ? tokens.input : undefined,
        outputTokens: typeof tokens?.output === "number" ? tokens.output : undefined,
      };
    } catch {
      return {};
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.client) return;
    await this.client.stop().catch(() => undefined);
    this.client = null;
    this.options.runStore.emit("worker:stop", { agentId: this.agentId });
  }

  private requireClient(): RpcClient {
    if (!this.client) throw new Error(`Worker ${this.agentId} used before start()`);
    return this.client;
  }
}
