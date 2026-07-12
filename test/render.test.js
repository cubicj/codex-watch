const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const bin = path.join(repoRoot, "bin", "codex-watch");
const timestamp = "2026-07-09T14:23:58.780Z";
const slug = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
let canonicalRepoRoot = repoRoot;
try {
  canonicalRepoRoot = fs.realpathSync.native(repoRoot);
} catch (_error) {}
const stateDirName = slug + "-" + crypto.createHash("sha256").update(canonicalRepoRoot).digest("hex").slice(0, 16);

function event(value) {
  return "[" + timestamp + "] " + value;
}

function eventAt(eventTimestamp, value) {
  return "[" + eventTimestamp + "] " + value;
}

function createFakeJob(dataDir, options) {
  const jobsDir = path.join(dataDir, "state", options.stateDirName || stateDirName, "jobs");
  const status = options.status || "running";
  const createdAt = options.createdAt || timestamp;
  const job = {
    id: options.id,
    kind: "task",
    title: options.title || options.id,
    workspaceRoot: repoRoot,
    summary: options.summary || "",
    createdAt,
    startedAt: options.startedAt || createdAt,
    status,
    phase: options.phase || status
  };

  if (status !== "running" && status !== "queued") {
    job.completedAt = options.completedAt || createdAt;
  }
  if (typeof options.threadId === "string") {
    job.threadId = options.threadId;
  }
  if (typeof options.write === "boolean") {
    job.write = options.write;
  }
  if (options.request && typeof options.request === "object") {
    job.request = options.request;
  }

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, options.id + ".json"), JSON.stringify(job));
  fs.writeFileSync(path.join(jobsDir, options.id + ".log"), options.lines.join("\n") + "\n");

  return job;
}

function createFakeRollout(codexHome, threadId, turnContexts, options = {}) {
  const sessionsDir = path.join(codexHome, "sessions", "2026", "07", "09");
  const entries = [
    { timestamp, type: "session_meta", payload: { id: threadId, cwd: options.cwd || repoRoot } },
    ...turnContexts.map((turnContext) => {
      if (turnContext && typeof turnContext === "object" && Object.hasOwn(turnContext, "payload")) {
        return {
          timestamp: typeof turnContext.timestamp === "string" ? turnContext.timestamp : timestamp,
          type: "turn_context",
          payload: turnContext.payload
        };
      }
      return { timestamp, type: "turn_context", payload: turnContext };
    }),
    ...(options.patchApplyEvents || []).map((patchApplyEvent) => ({
      timestamp: patchApplyEvent.timestamp,
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: patchApplyEvent.callId || "call-1",
        success: patchApplyEvent.success !== false,
        changes: patchApplyEvent.changes
      }
    }))
  ];
  const rolloutPath = path.join(sessionsDir, "rollout-2026-07-09T23-23-59-" + threadId + ".jsonl");

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  return rolloutPath;
}

function getFakeJobLogPath(dataDir, id) {
  return path.join(dataDir, "state", stateDirName, "jobs", id + ".log");
}

function getFakeJobJsonPath(dataDir, id) {
  return getFakeJobLogPath(dataDir, id).replace(/\.log$/, ".json");
}

function runCodexWatch(args, dataDir, codexHome = path.join(dataDir, "codex-home")) {
  const stdoutPath = path.join(dataDir, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        CODEX_HOME: codexHome
      },
      stdio: ["ignore", stdoutFd, "pipe"]
    });

    return {
      ...result,
      stdout: fs.readFileSync(stdoutPath, "utf8")
    };
  } finally {
    fs.closeSync(stdoutFd);
  }
}

function runFollowMode(args, dataDir, durationMs, codexHome = path.join(dataDir, "codex-home")) {
  const stdoutPath = path.join(dataDir, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let child;

    function finish(error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      fs.closeSync(stdoutFd);

      if (error) {
        reject(error);
        return;
      }

      resolve(fs.readFileSync(stdoutPath, "utf8"));
    }

    try {
      child = spawn(process.execPath, [bin, ...args], {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: dataDir,
          CODEX_HOME: codexHome
        },
        stdio: ["ignore", stdoutFd, "pipe"]
      });
    } catch (error) {
      finish(error);
      return;
    }

    child.once("error", finish);
    child.once("close", () => finish());
    timer = setTimeout(() => child.kill("SIGINT"), durationMs);
  });
}

test("header contains the job id and status", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "header-job",
      status: "completed",
      phase: "completed",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job header-job \| status completed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders session info under the job header", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174001";
  const expected = "model gpt-5.4-mini · effort low · sandbox danger-full-access · write";

  try {
    createFakeJob(tempDir, {
      id: "session-info-job",
      threadId,
      write: true,
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        model: "gpt-5.4-mini",
        effort: "low",
        sandbox_policy: { type: "danger-full-access" }
      }
    ]);

    const result = runCodexWatch(["--once"], tempDir, codexHome);
    const outputLines = result.stdout.split(/\r?\n/);
    const headerIndex = outputLines.findIndex((line) => line.startsWith("job session-info-job "));

    assert.strictEqual(result.status, 0);
    assert.notStrictEqual(headerIndex, -1);
    assert.strictEqual(outputLines[headerIndex + 1], expected);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders requested model when no rollout exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "requested-model-job",
      threadId: "123e4567-e89b-12d3-a456-42661417400a",
      request: { model: "gpt-5.3-codex-spark", effort: null, write: false },
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model gpt-5\.3-codex-spark \(requested\)$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders requested model and effort when no rollout exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "requested-model-effort-job",
      threadId: "123e4567-e89b-12d3-a456-42661417400b",
      request: { model: "gpt-5.3-codex-spark", effort: "high", write: true },
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(
      result.stdout,
      /^model gpt-5\.3-codex-spark \(requested\) · effort high \(requested\)$/m
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once prefers rollout session info over requested values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-42661417400c";

  try {
    createFakeJob(tempDir, {
      id: "rollout-over-request-job",
      threadId,
      write: true,
      request: { model: "requested-model", effort: "low", write: false },
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        model: "resolved-model",
        effort: "high",
        sandbox_policy: { type: "danger-full-access" }
      }
    ]);

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model resolved-model · effort high · sandbox danger-full-access · write$/m);
    assert.doesNotMatch(result.stdout, /requested/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once omits session info without request or rollout", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "missing-rollout-job",
      threadId: "123e4567-e89b-12d3-a456-426614174002",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /^model /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once uses the last rollout turn context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174003";

  try {
    createFakeJob(tempDir, {
      id: "last-turn-context-job",
      threadId,
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      { model: "gpt-5.3", effort: "high" },
      { model: "gpt-5.4-mini", effort: "low" }
    ]);

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model gpt-5\.4-mini · effort low · read-only$/m);
    assert.doesNotMatch(result.stdout, /^model gpt-5\.3 /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once rejects rollout turn context older than the job start", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174007";

  try {
    createFakeJob(tempDir, {
      id: "stale-turn-context-job",
      startedAt: "2026-07-09T14:24:00.000Z",
      threadId,
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        timestamp: "2026-07-09T14:23:59.000Z",
        payload: { model: "stale-model" }
      }
    ]);

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /^model /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once uses the latest qualifying rollout turn context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174008";

  try {
    createFakeJob(tempDir, {
      id: "fresh-turn-context-job",
      startedAt: "2026-07-09T14:24:00.000Z",
      threadId,
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        timestamp: "2026-07-09T14:23:59.000Z",
        payload: { model: "stale-model" }
      },
      {
        timestamp: "2026-07-09T14:24:01.000Z",
        payload: { model: "fresh-model" }
      }
    ]);

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model fresh-model · read-only$/m);
    assert.doesNotMatch(result.stdout, /^model stale-model /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders read-only when write is absent or false", () => {
  for (const write of [undefined, false]) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
    const codexHome = path.join(tempDir, "codex-home");
    const suffix = write === false ? "false" : "absent";
    const threadId = "123e4567-e89b-12d3-a456-4266141740" + (write === false ? "05" : "04");

    try {
      createFakeJob(tempDir, {
        id: "read-only-" + suffix + "-job",
        threadId,
        write,
        lines: [event("Starting Codex Task.")]
      });
      createFakeRollout(codexHome, threadId, [{ model: "gpt-5.4-mini" }]);

      const result = runCodexWatch(["--once"], tempDir, codexHome);

      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /^model gpt-5\.4-mini · read-only$/m);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("follow mode prints session info once when threadId appears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174006";
  const expected = "model gpt-5.4-mini · effort low · sandbox danger-full-access · write";
  let rewriteTimer = null;

  try {
    const job = createFakeJob(tempDir, {
      id: "late-thread-id-job",
      status: "running",
      phase: "executing",
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        model: "gpt-5.4-mini",
        effort: "low",
        sandbox_policy: { type: "danger-full-access" }
      }
    ]);

    const stdoutPromise = runFollowMode([], tempDir, 1800, codexHome);
    rewriteTimer = setTimeout(() => {
      fs.writeFileSync(getFakeJobJsonPath(tempDir, job.id), JSON.stringify({ ...job, threadId, write: true }));
    }, 600);

    const stdout = await stdoutPromise;
    const occurrences = stdout.split(/\r?\n/).filter((line) => line === expected).length;

    assert.strictEqual(occurrences, 1);
  } finally {
    clearTimeout(rewriteTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode waits for a qualifying rollout turn context", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174009";
  const expected = "model fresh-model · effort high · read-only";
  let appendTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "late-turn-context-job",
      startedAt: "2026-07-09T14:24:00.000Z",
      threadId,
      request: { model: "requested-model", effort: "medium" },
      lines: [event("Starting Codex Task.")]
    });
    const rolloutPath = createFakeRollout(codexHome, threadId, [
      {
        timestamp: "2026-07-09T14:23:59.000Z",
        payload: { model: "stale-model", effort: "low" }
      }
    ]);

    const stdoutPromise = runFollowMode([], tempDir, 1800, codexHome);
    appendTimer = setTimeout(() => {
      fs.appendFileSync(
        rolloutPath,
        JSON.stringify({
          timestamp: "2026-07-09T14:24:01.000Z",
          type: "turn_context",
          payload: { model: "fresh-model", effort: "high" }
        }) + "\n"
      );
    }, 600);

    const stdout = await stdoutPromise;
    const sessionInfoLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("model "));

    assert.deepStrictEqual(sessionInfoLines, [
      "model requested-model (requested) · effort medium (requested)",
      expected
    ]);
  } finally {
    clearTimeout(appendTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode switches to a greater job id with the same createdAt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  let createTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "switch-tie-a-job",
      lines: [event("Assistant message"), "First job output."]
    });

    const stdoutPromise = runFollowMode([], tempDir, 1800);
    createTimer = setTimeout(() => {
      createFakeJob(tempDir, {
        id: "switch-tie-b-job",
        lines: [event("Assistant message"), "Second job output."]
      });
    }, 600);

    const stdout = await stdoutPromise;

    assert.match(stdout, /job switch-tie-a-job \| status running/);
    assert.match(stdout, /switched to switch-tie-b-job/);
    assert.match(stdout, /Second job output\./);
  } finally {
    clearTimeout(createTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assistant message body lines appear verbatim", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const firstLine = "The first assistant line.";
  const secondLine = "The second assistant line keeps punctuation: [] {}.";

  try {
    createFakeJob(tempDir, {
      id: "assistant-body-job",
      lines: [
        event("Starting Codex Task."),
        event("Thread ready (123e4567-e89b-12d3-a456-426614174000)."),
        event("Turn started (123e4567-e89b-12d3-a456-426614174000)."),
        event("Assistant message captured: The first assistant line."),
        "",
        event("Assistant message"),
        firstLine,
        secondLine,
        event("Turn completed.")
      ]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const outputLines = result.stdout.split(/\r?\n/);

    assert.strictEqual(result.status, 0);
    assert.ok(outputLines.includes(firstLine));
    assert.ok(outputLines.includes(secondLine));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bracketed assistant body lines are not parsed as event markers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const firstBracketedLine = "[x] first item";
  const commandLikeBodyLine = "[note] Command completed: x (exit 0)";
  const trailingLine = "Trailing assistant body line.";
  const completedLine = "✓ Command completed: x (exit 0)";

  try {
    createFakeJob(tempDir, {
      id: "bracketed-assistant-body-job",
      lines: [
        event("Assistant message"),
        firstBracketedLine,
        commandLikeBodyLine,
        trailingLine,
        event("Command completed: x (exit 0)")
      ]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const outputLines = result.stdout.split(/\r?\n/);

    assert.strictEqual(result.status, 0);
    assert.ok(outputLines.includes(firstBracketedLine));
    assert.ok(outputLines.includes(commandLikeBodyLine));
    assert.ok(outputLines.includes(trailingLine));
    assert.ok(!outputLines.includes("✓ " + commandLikeBodyLine));
    assert.strictEqual(outputLines.filter((line) => line === completedLine).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assistant message captured preamble is suppressed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "assistant-preamble-job",
      lines: [
        event("Assistant message captured: Hidden preamble."),
        "",
        event("Assistant message"),
        "Visible assistant body."
      ]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Assistant message captured:/);
    assert.match(result.stdout, /Visible assistant body\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("thinking event renders a Thinking indicator", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "thinking-job",
      lines: [event("Thinking.")]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const thinkingLines = result.stdout.split(/\r?\n/).filter((line) => line === "Thinking...");

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(thinkingLines, ["Thinking..."]);
    assert.doesNotMatch(result.stdout, /^Thinking\.$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("consecutive thinking events render one Thinking indicator", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "consecutive-thinking-job",
      lines: [event("Thinking."), event("Thinking."), event("Thinking.")]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const thinkingLines = result.stdout.split(/\r?\n/).filter((line) => line === "Thinking...");

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(thinkingLines, ["Thinking..."]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rendered output resets the Thinking indicator collapse", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "separated-thinking-job",
      lines: [event("Thinking."), event("Running command: x"), event("Thinking.")]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const outputLines = result.stdout.split(/\r?\n/);
    const firstThinkingIndex = outputLines.indexOf("Thinking...");
    const commandIndex = outputLines.indexOf("Running command: x");
    const lastThinkingIndex = outputLines.lastIndexOf("Thinking...");

    assert.strictEqual(result.status, 0);
    assert.ok(firstThinkingIndex < commandIndex);
    assert.ok(commandIndex < lastThinkingIndex);
    assert.strictEqual(outputLines.filter((line) => line === "Thinking...").length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("command completion uses success and failure prefixes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "command-completion-job",
      lines: [
        event("Running command: x"),
        event("Command completed: x (exit 0)"),
        event("Command completed: x (exit 1)")
      ]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^✓ Command completed: x \(exit 0\)$/m);
    assert.match(result.stdout, /^✗ Command completed: x \(exit 1\)$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applying file changes renders a matching updated file relative to rollout cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174010";
  const changedPath = path.join(repoRoot, "bin", "codex-watch");

  try {
    createFakeJob(tempDir, {
      id: "single-file-change-job",
      threadId,
      lines: [event("Applying 1 file change(s).")]
    });
    createFakeRollout(codexHome, threadId, [], {
      patchApplyEvents: [{ timestamp, changes: { [changedPath]: { type: "update" } } }]
    });

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^Applying 1 file change\(s\)\.$/m);
    assert.match(result.stdout, /^  M bin\/codex-watch$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applying file changes renders update add and delete files in rollout order", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174011";
  const changes = {
    [path.join(repoRoot, "bin", "codex-watch")]: { type: "update" },
    [path.join(repoRoot, "test", "new.test.js")]: { type: "add" },
    [path.join(repoRoot, "old.txt")]: { type: "delete" }
  };

  try {
    createFakeJob(tempDir, {
      id: "multiple-file-changes-job",
      threadId,
      lines: [event("Applying 3 file change(s).")]
    });
    createFakeRollout(codexHome, threadId, [], {
      patchApplyEvents: [{ timestamp, changes }]
    });

    const result = runCodexWatch(["--once"], tempDir, codexHome);
    const outputLines = result.stdout.split(/\r?\n/);
    const applyingIndex = outputLines.indexOf("Applying 3 file change(s).");

    assert.strictEqual(result.status, 0);
    assert.notStrictEqual(applyingIndex, -1);
    assert.deepStrictEqual(outputLines.slice(applyingIndex + 1, applyingIndex + 4), [
      "  M bin/codex-watch",
      "  A test/new.test.js",
      "  D old.txt"
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applying file changes stays plain when no rollout exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "missing-file-change-rollout-job",
      threadId: "123e4567-e89b-12d3-a456-426614174012",
      lines: [event("Applying 1 file change(s).")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^Applying 1 file change\(s\)\.$/m);
    assert.doesNotMatch(result.stdout, /^  [MAD] /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applying file changes ignores rollout events outside the two second window", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174013";
  const changedPath = path.join(repoRoot, "outside-window.txt");

  try {
    createFakeJob(tempDir, {
      id: "outside-window-file-change-job",
      threadId,
      lines: [event("Applying 1 file change(s).")]
    });
    createFakeRollout(codexHome, threadId, [], {
      patchApplyEvents: [{
        timestamp: "2026-07-09T14:24:00.781Z",
        changes: { [changedPath]: { type: "update" } }
      }]
    });

    const result = runCodexWatch(["--once"], tempDir, codexHome);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^Applying 1 file change\(s\)\.$/m);
    assert.doesNotMatch(result.stdout, /outside-window\.txt/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("consecutive applying file changes consume matching rollout events in order", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174014";
  const secondTimestamp = "2026-07-09T14:23:59.780Z";

  try {
    createFakeJob(tempDir, {
      id: "ordered-file-changes-job",
      threadId,
      lines: [
        event("Applying 1 file change(s)."),
        eventAt(secondTimestamp, "Applying 1 file change(s).")
      ]
    });
    createFakeRollout(codexHome, threadId, [], {
      patchApplyEvents: [
        {
          timestamp: "2026-07-09T14:23:58.785Z",
          callId: "call-1",
          changes: { [path.join(repoRoot, "first.txt")]: { type: "update" } }
        },
        {
          timestamp: "2026-07-09T14:23:59.790Z",
          callId: "call-2",
          changes: { [path.join(repoRoot, "second.txt")]: { type: "add" } }
        }
      ]
    });

    const result = runCodexWatch(["--once"], tempDir, codexHome);
    const outputLines = result.stdout.split(/\r?\n/);
    const applyingIndexes = outputLines
      .map((line, index) => line === "Applying 1 file change(s)." ? index : -1)
      .filter((index) => index !== -1);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(applyingIndexes.length, 2);
    assert.strictEqual(outputLines[applyingIndexes[0] + 1], "  M first.txt");
    assert.strictEqual(outputLines[applyingIndexes[1] + 1], "  A second.txt");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("running command is truncated after 139 characters", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const command = "x".repeat(160);

  try {
    createFakeJob(tempDir, {
      id: "long-command-job",
      lines: [event("Running command: " + command)]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const runningLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("Running command: "));

    assert.strictEqual(result.status, 0);
    assert.strictEqual(runningLine, "Running command: " + command.slice(0, 139) + "…");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("running command truncation keeps astral-plane characters intact", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const command = "x".repeat(138) + "😀" + "y".repeat(20);

  try {
    createFakeJob(tempDir, {
      id: "astral-truncation-job",
      lines: [event("Running command: " + command)]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const runningLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("Running command: "));

    assert.strictEqual(result.status, 0);
    assert.ok(runningLine);
    assert.ok(runningLine.includes("😀"));
    assert.doesNotMatch(runningLine, /�/);
    assert.ok(runningLine.endsWith("…"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders the job with the newest createdAt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "older-job",
      createdAt: "2026-07-09T14:22:58.780Z",
      lines: [event("Assistant message"), "Older job output."]
    });
    createFakeJob(tempDir, {
      id: "newer-job",
      createdAt: "2026-07-09T14:23:58.780Z",
      lines: [event("Assistant message"), "Newer job output."]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job newer-job \| status running/);
    assert.match(result.stdout, /Newer job output\./);
    assert.doesNotMatch(result.stdout, /Older job output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once ignores a newer job in a same-slug decoy state dir", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "correct-state-job",
      createdAt: "2026-07-09T14:22:58.780Z",
      lines: [event("Assistant message"), "Correct state output."]
    });
    createFakeJob(tempDir, {
      id: "decoy-state-job",
      stateDirName: slug + "-ffffffffffffffff",
      createdAt: "2026-07-09T14:23:58.780Z",
      lines: [event("Assistant message"), "Decoy state output."]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job correct-state-job \| status running/);
    assert.match(result.stdout, /Correct state output\./);
    assert.doesNotMatch(result.stdout, /Decoy state output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once uses the greater job id when createdAt values match", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "tie-a-job",
      lines: [event("Assistant message"), "Lower id output."]
    });
    createFakeJob(tempDir, {
      id: "tie-b-job",
      lines: [event("Assistant message"), "Greater id output."]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job tie-b-job \| status running/);
    assert.match(result.stdout, /Greater id output\./);
    assert.doesNotMatch(result.stdout, /Lower id output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once prints a completed job banner after the log body", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const bodyLine = "Completed once body.";
  const banner = "✓ completed · 8s";

  try {
    createFakeJob(tempDir, {
      id: "once-completed-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      startedAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "completed",
      phase: "completed",
      lines: [event("Assistant message"), bodyLine, event("Turn completed.")]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const bodyIndex = result.stdout.indexOf(bodyLine);
    const bannerIndex = result.stdout.indexOf(banner);

    assert.strictEqual(result.status, 0);
    assert.notStrictEqual(bodyIndex, -1);
    assert.notStrictEqual(bannerIndex, -1);
    assert.ok(bannerIndex > bodyIndex);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once prints no completion banner for a running job", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "once-running-job",
      status: "running",
      phase: "executing",
      lines: [event("Assistant message"), "Running job body."]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /^(?:✓ completed|✗ \S+) · /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode prints the header for an existing job", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "follow-job",
      status: "running",
      phase: "executing",
      lines: [event("Starting Codex Task.")]
    });

    const stdout = await runFollowMode([], tempDir, 1500);

    assert.match(stdout, /job follow-job \| status running/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("completed job banner uses startedAt and completedAt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "completed-duration-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      startedAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "completed",
      phase: "completed",
      lines: [event("Starting Codex Task."), event("Turn completed.")]
    });

    const stdout = await runFollowMode([], tempDir, 1500);

    assert.match(stdout, /^✓ completed · 8s$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("completion banner follows rendered log output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const bodyLine = "Completed job body.";
  const bannerPrefix = "✓ completed · ";

  try {
    createFakeJob(tempDir, {
      id: "completed-order-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      startedAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "completed",
      phase: "completed",
      lines: [event("Assistant message"), bodyLine, event("Turn completed.")]
    });

    const stdout = await runFollowMode([], tempDir, 1500);
    const bodyIndex = stdout.indexOf(bodyLine);
    const bannerIndex = stdout.indexOf(bannerPrefix);

    assert.notStrictEqual(bodyIndex, -1);
    assert.notStrictEqual(bannerIndex, -1);
    assert.ok(bannerIndex > bodyIndex);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed job banner uses startedAt and completedAt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "failed-duration-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      startedAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "failed",
      phase: "failed",
      lines: [event("Starting Codex Task."), event("Turn completed.")]
    });

    const stdout = await runFollowMode([], tempDir, 1500);

    assert.match(stdout, /^✗ failed · 8s$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode preserves UTF-8 split across chunks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const id = "utf8-split-job";
  const koreanLine = "한글 메시지가 온전히 출력된다.";
  const marker = event("Assistant message") + "\n";
  const fullLog = Buffer.from(marker + koreanLine + "\n");
  const splitAt = Buffer.byteLength(marker) + 1;
  let appendTimer = null;

  try {
    createFakeJob(tempDir, {
      id,
      status: "running",
      phase: "executing",
      lines: []
    });

    const logPath = getFakeJobLogPath(tempDir, id);
    fs.writeFileSync(logPath, fullLog.subarray(0, splitAt));

    const stdoutPromise = runFollowMode([], tempDir, 2000);
    appendTimer = setTimeout(() => {
      fs.appendFileSync(logPath, fullLog.subarray(splitAt));
    }, 600);

    const stdout = await stdoutPromise;
    const outputLines = stdout.split(/\r?\n/);

    assert.ok(outputLines.includes(koreanLine));
    assert.doesNotMatch(stdout, /�/);
  } finally {
    clearTimeout(appendTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("closed stdout pipe exits cleanly", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const id = "epipe-job";
  let child = null;

  try {
    createFakeJob(tempDir, {
      id,
      status: "running",
      phase: "executing",
      lines: [event("Starting Codex Task.")]
    });

    const logPath = getFakeJobLogPath(tempDir, id);
    child = spawn(process.execPath, [bin], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tempDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const exit = await new Promise((resolve, reject) => {
      const hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);

      child.once("error", (error) => {
        clearTimeout(hardKillTimer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(hardKillTimer);
        resolve({ code, signal });
      });
      child.stdout.once("data", () => {
        child.stdout.destroy();
        fs.appendFileSync(logPath, event("Turn completed.") + "\n");
      });
    });

    assert.strictEqual(exit.code, 0);
    assert.doesNotMatch(stderr, /EPIPE/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
