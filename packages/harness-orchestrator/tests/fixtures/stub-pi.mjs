#!/usr/bin/env node
/**
 * A minimal stand-in for `pi --mode rpc`.
 *
 * It exists so the Worker's use of the RPC protocol can be tested without
 * credentials or spend: request/response correlation, the agent_settled signal
 * that waitForIdle depends on, session-stats field names, and the startup
 * probe. Those are exactly the places where a wrong assumption previously cost
 * a twenty-minute hang to discover.
 *
 * Behaviour is switched by STUB_MODE:
 *   normal (default) - answers everything and settles after each prompt
 *   silent           - accepts prompts but never settles, so turns time out
 *   crash            - exits immediately, as a wedged process would
 */

const mode = process.env.STUB_MODE ?? "normal";

if (mode === "crash") {
  process.stderr.write("stub-pi: simulated startup failure\n");
  process.exit(1);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (request, data) =>
  write({ type: "response", id: request.id, command: request.type, success: true, data });

let promptCount = 0;

const handle = (request) => {
  switch (request.type) {
    case "get_state":
      respond(request, { isStreaming: false, messageCount: promptCount });
      return;

    case "set_auto_retry":
    case "set_thinking_level":
    case "set_model":
      respond(request, null);
      return;

    case "prompt": {
      promptCount++;
      respond(request, null);
      if (mode === "silent") return; // never settles, on purpose

      write({ type: "agent_start" });
      write({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
      });
      write({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "x" },
      });
      write({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", isError: false });
      write({ type: "agent_end" });
      write({ type: "agent_settled" });
      return;
    }

    case "get_last_assistant_text":
      // pi wraps this in an object and RpcClient unwraps `.text`; returning a
      // bare string yields undefined at the call site.
      respond(request, { text: `reply ${promptCount}` });
      return;

    case "get_session_stats":
      // Shape mirrors pi's SessionStats: cost at the top level, token counts
      // nested under `tokens`.
      respond(request, {
        sessionId: "stub",
        totalMessages: promptCount * 2,
        tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
        cost: 0.4242,
      });
      return;

    case "abort":
      respond(request, null);
      return;

    default:
      respond(request, null);
  }
};

// Strict LF-only framing, matching pi's own reader.
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim().length > 0) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`stub-pi: ${error.message}\n`);
      }
    }
    index = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
