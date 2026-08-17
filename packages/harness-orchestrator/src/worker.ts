import type { HarnessConfig, RunStore } from "@harness/core";
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
  config: HarnessConfig;
  runStore: RunStore;
  /** Streamed assistant text, for CLI progress rendering. */
  onText?: (delta: string) => void;
  /** Overrides the model from config, e.g. a cheaper tier for repair turns. */
  model?: { provider: string; id?: string };
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
    const { config, worktree, runStore, agentId } = this.options;
    const model = this.options.model ?? config.model;

    const client = createPiSession({
      cwd: worktree,
      provider: model.provider,
      ...(model.id ? { model: model.id } : {}),
      thinking: config.model.thinking,
      tools: config.builder.tools,
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

    await client.start();
    // Transient provider errors (429/5xx) are common with subscription auth and
    // concurrent workers; let pi absorb them rather than failing the run.
    await client.setAutoRetry(true);
    this.client = client;

    runStore.emit("worker:start", { agentId, worktree });
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
      const raw = (await client.getSessionStats()) as unknown as Record<string, unknown>;
      // Stats field names have moved across pi versions; read defensively so a
      // rename degrades the cost report instead of failing the run.
      const usage = (raw.usage ?? raw) as Record<string, unknown>;
      return {
        costUsd: typeof raw.cost === "number" ? raw.cost : undefined,
        inputTokens: typeof usage.input === "number" ? usage.input : undefined,
        outputTokens: typeof usage.output === "number" ? usage.output : undefined,
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
