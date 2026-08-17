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

/**
 * Role-play the pipeline.
 *
 * The stub identifies its role from markers in the prompt rather than from a
 * flag, which means the pipeline's real prompts are what drive it. A prompt
 * rewrite that drops a marker breaks these tests, which is the intent: the
 * prompts are load-bearing.
 */
const OUT = `${process.cwd()}/.harness-out`;

const writeArtifact = async (name, value) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, JSON.stringify(value, null, 2), "utf8");
};

/** Pull the backticked paths out of a named section of the prompt. */
const pathsUnder = (message, heading) => {
  // One-or-more newlines: "## Files this unit owns" is followed by a blank
  // line, "Conflicted files:" is not.
  const section = new RegExp(`${heading}\\n+([\\s\\S]*?)\\n\\n`).exec(message);
  if (!section) return [];
  return [...(section[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
};

const ownedFiles = (message) => pathsUnder(message, "## Files this unit owns");
const conflictedFiles = (message) => pathsUnder(message, "Conflicted files:");

const PLAN = {
  summary: "Stub plan: two independent units.",
  constraints: ["Do not modify the other unit's files."],
  risks: ["The units might both need shared config."],
  units: [
    {
      id: "alpha",
      title: "Alpha unit",
      brief: "Create the alpha module.",
      files: ["src/alpha.ts"],
      dependsOn: [],
      acceptance: ["src/alpha.ts exports alpha"],
    },
    {
      id: "beta",
      title: "Beta unit",
      brief: "Create the beta module.",
      files: ["src/beta.ts"],
      dependsOn: [],
      acceptance: ["src/beta.ts exports beta"],
    },
  ],
};

async function actOnPrompt(message) {
  const { mkdirSync, writeFileSync } = await import("node:fs");

  // Anchored to the start of the prompt, not merely contained in it. The
  // implement prompt has a "## Design constraints" heading, so a substring
  // check on "# Design" makes every implementer write a plan instead of code.
  if (message.startsWith("# Adversarial review found")) {
    await writeArtifact("response-1.json", {
      rebuttals: [{ findingId: "f1", action: "disputed", explanation: "Stub disputes this." }],
    });
    return;
  }

  if (message.startsWith("# Design")) {
    await writeArtifact("plan.json", PLAN);
    return;
  }

  if (message.startsWith("# Implement:")) {
    const files = ownedFiles(message);
    for (const file of files) {
      const name = file.split("/").pop()?.replace(/\.ts$/, "") ?? "mod";
      mkdirSync(`${process.cwd()}/${file}`.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(`${process.cwd()}/${file}`, `export const ${name} = true;\n`, "utf8");
    }
    // Deliberately overstep into a shared file so the units collide at merge
    // time and the combiner has something real to resolve.
    if (process.env.STUB_CONFLICT) {
      const owner = files[0]?.includes("alpha") ? "alpha" : "beta";
      writeFileSync(`${process.cwd()}/src/shared.ts`, `export const shared = "${owner}";\n`, "utf8");
    }
    return;
  }

  if (message.startsWith("# Resolve merge conflicts")) {
    for (const file of conflictedFiles(message)) {
      writeFileSync(
        `${process.cwd()}/${file}`,
        'export const shared = "alpha+beta";\n',
        "utf8",
      );
    }
    return;
  }

  if (message.startsWith("# Adversarial review")) {
    const finding = process.env.STUB_FINDING;
    await writeArtifact(
      "review.json",
      finding
        ? {
            approved: false,
            coverage: ["ran the module", "read the diff"],
            findings: [
              {
                id: "f1",
                severity: finding,
                file: "src/alpha.ts",
                claim: "Stub finding for testing.",
                reproduction: "Import the module and call it with no arguments.",
                verifiedByExecution: true,
              },
            ],
          }
        : { approved: true, coverage: ["ran the module", "read the diff"], findings: [] },
    );
    return;
  }

}

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

      // Side effects land before agent_settled, matching a real agent: the
      // harness reads artifacts and diffs only once the turn has settled.
      void actOnPrompt(String(request.message ?? "")).then(() => {
        write({ type: "agent_end" });
        write({ type: "agent_settled" });
      });

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
