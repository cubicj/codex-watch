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
  if (typeof options.pid === "number") {
    job.pid = options.pid;
  }
  if (typeof options.write === "boolean") {
    job.write = options.write;
  }
  if (options.request && typeof options.request === "object") {
    job.request = options.request;
  }
  if (options.resolved && typeof options.resolved === "object") {
    job.resolved = options.resolved;
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

function buildRunEnv(dataDir, codexHome, envOverrides) {
  const env = {
    ...process.env,
    CODEX_COMPANION_PLUGIN_DATA: null,
    CLAUDE_PLUGIN_DATA: dataDir,
    CODEX_HOME: codexHome,
    ...envOverrides
  };
  for (const key of Object.keys(env)) {
    if (env[key] === null) {
      delete env[key];
    }
  }
  return env;
}

function runCodexWatch(args, dataDir, codexHome = path.join(dataDir, "codex-home"), envOverrides = {}) {
  const stdoutPath = path.join(dataDir, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: buildRunEnv(dataDir, codexHome, envOverrides),
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

function runFollowMode(args, dataDir, durationMs, codexHome = path.join(dataDir, "codex-home"), envOverrides = {}) {
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
        env: buildRunEnv(dataDir, codexHome, envOverrides),
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

function runFollowUntilExit(args, dataDir, codexHome = path.join(dataDir, "codex-home")) {
  const stdoutPath = path.join(dataDir, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: buildRunEnv(dataDir, codexHome),
      stdio: ["ignore", stdoutFd, "pipe"]
    });
    const hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(hardKillTimer);
      fs.closeSync(stdoutFd);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(hardKillTimer);
      fs.closeSync(stdoutFd);
      resolve({ code, signal, stderr, stdout: fs.readFileSync(stdoutPath, "utf8") });
    });
  });
}

function getExitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { env: buildRunEnv() });
    const pid = child.pid;

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(pid);
        return;
      }
      reject(new Error("child exited with status " + code));
    });
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
  const expected = "model gpt-5.4-mini · effort low · sandbox danger-full-access";

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
    assert.match(result.stdout, /^model resolved-model · effort high · sandbox danger-full-access$/m);
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
    assert.match(result.stdout, /^model gpt-5\.4-mini · effort low$/m);
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
    assert.match(result.stdout, /^model fresh-model$/m);
    assert.doesNotMatch(result.stdout, /^model stale-model /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders no access suffix when write is absent or false", () => {
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
      assert.match(result.stdout, /^model gpt-5\.4-mini$/m);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("follow mode prints session info once when threadId appears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174006";
  const expected = "model gpt-5.4-mini · effort low · sandbox danger-full-access";
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
  const expected = "model fresh-model · effort high";
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

test("header elapsed stops at completedAt for a cancelled job", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "cancelled-header-job",
      status: "cancelled",
      createdAt: "2026-07-09T14:22:00.000Z",
      startedAt: "2026-07-09T14:22:14.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      lines: []
    });

    const result = runCodexWatch(["--once"], tempDir);
    const header = result.stdout.split(/\r?\n/)[0];

    assert.strictEqual(result.status, 0);
    assert.strictEqual(header, "job cancelled-header-job | status cancelled | phase cancelled | elapsed 1m 44s");
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
      env: buildRunEnv(tempDir, path.join(tempDir, "codex-home")),
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

test("list prints jobs newest first with a marker on the newest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "list-old-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "completed",
      phase: "completed",
      summary: "Old job summary.",
      lines: [event("Turn completed.")]
    });
    createFakeJob(tempDir, {
      id: "list-new-job",
      createdAt: "2026-07-09T14:25:00.000Z",
      status: "running",
      phase: "executing",
      summary: "New job summary.",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--list"], tempDir);
    const outputLines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(outputLines.length, 2);
    assert.match(outputLines[0], /^\* list-new-job\s+running\s+started \d{2}:\d{2}:\d{2} \(.+\)  New job summary\.$/);
    assert.match(outputLines[1], /^ {2}list-old-job\s+completed\s+started \d{2}:\d{2}:\d{2} \(8s\)  Old job summary\.$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list with no jobs prints the empty message and exits 0", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--list"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^No Codex job found for /m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list truncates long summaries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "list-long-summary-job",
      summary: "s".repeat(160),
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--list"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /s{139}…$/m);
    assert.doesNotMatch(result.stdout, /s{140}/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list omits the summary column for jobs without a summary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "list-no-summary-job",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--list"], tempDir);
    const line = result.stdout.split(/\r?\n/).find((value) => value.includes("list-no-summary-job"));

    assert.strictEqual(result.status, 0);
    assert.ok(line);
    assert.match(line, /\)$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once with an exact job id renders that job instead of the newest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "pin-old-job",
      createdAt: "2026-07-09T14:22:00.000Z",
      lines: [event("Assistant message"), "Pinned old output."]
    });
    createFakeJob(tempDir, {
      id: "pin-new-job",
      createdAt: "2026-07-09T14:25:00.000Z",
      lines: [event("Assistant message"), "Unpinned new output."]
    });

    const result = runCodexWatch(["--once", "--job", "pin-old-job"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job pin-old-job \| status running/);
    assert.match(result.stdout, /Pinned old output\./);
    assert.doesNotMatch(result.stdout, /Unpinned new output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once with a unique job id prefix renders the matching job", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "prefix-target-job",
      lines: [event("Assistant message"), "Prefix target output."]
    });
    createFakeJob(tempDir, {
      id: "other-job",
      lines: [event("Assistant message"), "Other output."]
    });

    const result = runCodexWatch(["--once", "--job", "prefix-t"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job prefix-target-job \| status running/);
    assert.match(result.stdout, /Prefix target output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once with an ambiguous job id prefix exits 1 listing candidates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "amb-a-job",
      lines: [event("Starting Codex Task.")]
    });
    createFakeJob(tempDir, {
      id: "amb-b-job",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once", "--job", "amb"], tempDir);

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /job id "amb" is ambiguous:/);
    assert.match(result.stderr, /amb-a-job/);
    assert.match(result.stderr, /amb-b-job/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once with an unknown job id exits 1", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "present-job",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once", "--job", "absent-job"], tempDir);

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /job "absent-job" not found in /);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pinned follow mode ignores newer jobs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "pin-follow-a-job",
      createdAt: "2026-07-09T14:22:00.000Z",
      lines: [event("Assistant message"), "Pinned follow output."]
    });
    createFakeJob(tempDir, {
      id: "pin-follow-b-job",
      createdAt: "2026-07-09T14:25:00.000Z",
      lines: [event("Assistant message"), "Newer follow output."]
    });

    const stdout = await runFollowMode(["--job", "pin-follow-a-job"], tempDir, 1500);

    assert.match(stdout, /job pin-follow-a-job \| status running/);
    assert.match(stdout, /Pinned follow output\./);
    assert.doesNotMatch(stdout, /switched to/);
    assert.doesNotMatch(stdout, /Newer follow output\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pinned follow mode exits 0 after the job completes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  let rewriteTimer = null;

  try {
    const job = createFakeJob(tempDir, {
      id: "pin-complete-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      status: "running",
      phase: "executing",
      lines: [event("Starting Codex Task.")]
    });

    const exitPromise = runFollowUntilExit(["--job", "pin-complete-job"], tempDir);
    rewriteTimer = setTimeout(() => {
      fs.writeFileSync(
        getFakeJobJsonPath(tempDir, job.id),
        JSON.stringify({
          ...job,
          status: "completed",
          phase: "completed",
          completedAt: "2026-07-09T14:23:58.000Z"
        })
      );
    }, 600);

    const result = await exitPromise;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.match(result.stdout, /^✓ completed · 8s$/m);
  } finally {
    clearTimeout(rewriteTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pinned follow mode renders an already completed job and exits 0", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "pin-done-job",
      createdAt: "2026-07-09T14:23:50.000Z",
      completedAt: "2026-07-09T14:23:58.000Z",
      status: "completed",
      phase: "completed",
      lines: [event("Assistant message"), "Already done body."]
    });

    const result = await runFollowUntilExit(["--job", "pin-done-job"], tempDir);

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.match(result.stdout, /job pin-done-job \| status completed/);
    assert.match(result.stdout, /Already done body\./);
    assert.match(result.stdout, /^✓ completed · 8s$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pinned follow mode exits 0 when the job record disappears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  let deleteTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "pin-pruned-job",
      status: "running",
      phase: "executing",
      lines: [event("Starting Codex Task.")]
    });

    const exitPromise = runFollowUntilExit(["--job", "pin-pruned-job"], tempDir);
    deleteTimer = setTimeout(() => {
      fs.rmSync(getFakeJobJsonPath(tempDir, "pin-pruned-job"));
    }, 600);

    const result = await exitPromise;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.match(result.stdout, /job record pin-pruned-job is gone — stopping\./);
  } finally {
    clearTimeout(deleteTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("discovers jobs under any plugin data root when CLAUDE_PLUGIN_DATA is unset", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const homeDir = path.join(tempDir, "home");
  const forkDataDir = path.join(homeDir, ".claude", "plugins", "data", "codex-codex-pretest");

  try {
    createFakeJob(forkDataDir, {
      id: "fork-root-job",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir, undefined, {
      CODEX_COMPANION_PLUGIN_DATA: null,
      CLAUDE_PLUGIN_DATA: null,
      HOME: homeDir
    });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job fork-root-job \| status running/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("picks the newest job across multiple plugin data roots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const homeDir = path.join(tempDir, "home");
  const stockDataDir = path.join(homeDir, ".claude", "plugins", "data", "codex-openai-codex");
  const forkDataDir = path.join(homeDir, ".claude", "plugins", "data", "codex-codex-pretest");

  try {
    createFakeJob(stockDataDir, {
      id: "older-root-job",
      createdAt: "2026-07-09T14:00:00.000Z",
      lines: [event("Starting Codex Task.")]
    });
    createFakeJob(forkDataDir, {
      id: "newer-root-job",
      createdAt: "2026-07-09T15:00:00.000Z",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir, undefined, {
      CODEX_COMPANION_PLUGIN_DATA: null,
      CLAUDE_PLUGIN_DATA: null,
      HOME: homeDir
    });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job newer-root-job \| status running/);
    assert.doesNotMatch(result.stdout, /older-root-job/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLAUDE_PLUGIN_DATA overrides home plugin data root scanning", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const homeDir = path.join(tempDir, "home");
  const overrideDataDir = path.join(tempDir, "override-data");
  const forkDataDir = path.join(homeDir, ".claude", "plugins", "data", "codex-codex-pretest");

  try {
    createFakeJob(forkDataDir, {
      id: "home-root-job",
      createdAt: "2026-07-09T15:00:00.000Z",
      lines: [event("Starting Codex Task.")]
    });
    createFakeJob(overrideDataDir, {
      id: "override-root-job",
      createdAt: "2026-07-09T14:00:00.000Z",
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], overrideDataDir, undefined, {
      HOME: homeDir
    });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job override-root-job \| status running/);
    assert.doesNotMatch(result.stdout, /home-root-job/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders the resolved session line over the requested fallback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "resolved-line-job",
      threadId: "123e4567-e89b-12d3-a456-426614174777",
      request: { model: "requested-model", effort: "medium" },
      resolved: {
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        reasoningEffort: "xhigh",
        sandbox: { type: "readOnly", networkAccess: false }
      },
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model gpt-5\.6-sol · effort xhigh · sandbox read-only$/m);
    assert.doesNotMatch(result.stdout, /requested/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once renders the resolved session line for jobs without a request key", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "review-resolved-job",
      threadId: "123e4567-e89b-12d3-a456-426614174778",
      resolved: {
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        sandbox: { type: "workspaceWrite" }
      },
      lines: [event("Starting Codex review.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^model gpt-5\.6-sol · effort medium · sandbox workspace-write$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode upgrades the requested line when resolved appears in the job JSON", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  let patchTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "resolved-upgrade-job",
      threadId: "123e4567-e89b-12d3-a456-426614174779",
      request: { model: "requested-model", effort: "medium" },
      lines: [event("Starting Codex Task.")]
    });

    const stdoutPromise = runFollowMode([], tempDir, 1800);
    patchTimer = setTimeout(() => {
      const jsonPath = getFakeJobJsonPath(tempDir, "resolved-upgrade-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.resolved = {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        sandbox: { type: "dangerFullAccess", networkAccess: false }
      };
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);

    const stdout = await stdoutPromise;
    const sessionInfoLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("model "));

    assert.deepStrictEqual(sessionInfoLines, [
      "model requested-model (requested) · effort medium (requested)",
      "model gpt-5.6-sol · effort xhigh · sandbox danger-full-access"
    ]);
  } finally {
    clearTimeout(patchTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode upgrades the resolved line when rollout session info appears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174780";
  let appendTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "rollout-upgrade-job",
      threadId,
      resolved: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        sandbox: { type: "readOnly" }
      },
      lines: [event("Starting Codex Task.")]
    });
    const rolloutPath = createFakeRollout(codexHome, threadId, [
      {
        timestamp: "2026-07-09T14:23:00.000Z",
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
          payload: { model: "rollout-model", effort: "high", sandbox_policy: { type: "danger-full-access" } }
        }) + "\n"
      );
    }, 600);

    const stdout = await stdoutPromise;
    const sessionInfoLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("model "));

    assert.deepStrictEqual(sessionInfoLines, [
      "model gpt-5.6-sol · effort xhigh · sandbox read-only",
      "model rollout-model · effort high · sandbox danger-full-access"
    ]);
  } finally {
    clearTimeout(appendTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode prints a thread id once when it appears in the job record", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const threadId = "123e4567-e89b-12d3-a456-426614174782";
  let patchTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "late-thread-job",
      threadId: "",
      request: { model: "requested-model", effort: "medium" },
      lines: [event("Starting Codex Task.")]
    });

    const stdoutPromise = runFollowMode([], tempDir, 1800);
    patchTimer = setTimeout(() => {
      const jsonPath = getFakeJobJsonPath(tempDir, "late-thread-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.threadId = threadId;
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);

    const stdout = await stdoutPromise;
    const threadLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("thread "));
    const sessionInfoLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("model "));

    assert.deepStrictEqual(threadLines, ["thread " + threadId]);
    assert.deepStrictEqual(sessionInfoLines, [
      "model requested-model (requested) · effort medium (requested)"
    ]);
  } finally {
    clearTimeout(patchTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a thread line between matching session tiers does not break session-line dedup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const codexHome = path.join(tempDir, "codex-home");
  const threadId = "123e4567-e89b-12d3-a456-426614174781";
  let patchTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "rollout-duplicate-job",
      threadId: "",
      resolved: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        sandbox: { type: "dangerFullAccess", networkAccess: false }
      },
      lines: [event("Starting Codex Task.")]
    });
    createFakeRollout(codexHome, threadId, [
      {
        timestamp: "2026-07-09T14:24:01.000Z",
        payload: { model: "gpt-5.6-sol", effort: "xhigh", sandbox_policy: { type: "danger-full-access" } }
      }
    ]);

    const stdoutPromise = runFollowMode([], tempDir, 1800, codexHome);
    patchTimer = setTimeout(() => {
      const jsonPath = getFakeJobJsonPath(tempDir, "rollout-duplicate-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.threadId = threadId;
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);

    const stdout = await stdoutPromise;
    const sessionInfoLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("model "));
    const threadLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("thread "));

    assert.deepStrictEqual(sessionInfoLines, [
      "model gpt-5.6-sol · effort xhigh · sandbox danger-full-access"
    ]);
    assert.deepStrictEqual(threadLines, ["thread " + threadId]);
  } finally {
    clearTimeout(patchTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once warns once when a queued worker pid is gone", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const deadPid = await getExitedChildPid();

  try {
    createFakeJob(tempDir, {
      id: "dead-once-job",
      status: "queued",
      pid: deadPid,
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);
    const warningLines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("⚠ worker pid "));

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(warningLines, ["⚠ worker pid " + deadPid + " is gone — job record is stale"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once does not warn when a running worker pid is alive", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "alive-once-job",
      status: "running",
      pid: process.pid,
      lines: [event("Starting Codex Task.")]
    });

    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /job record is stale/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow mode warns once when a refreshed worker pid is gone", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const deadPid = await getExitedChildPid();
  let patchTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "dead-follow-job",
      status: "running",
      pid: process.pid,
      lines: [event("Starting Codex Task.")]
    });

    const stdoutPromise = runFollowMode([], tempDir, 1800);
    patchTimer = setTimeout(() => {
      const jsonPath = getFakeJobJsonPath(tempDir, "dead-follow-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.pid = deadPid;
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);

    const stdout = await stdoutPromise;
    const warningLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("⚠ worker pid "));

    assert.deepStrictEqual(warningLines, ["⚠ worker pid " + deadPid + " is gone — job record is stale"]);
  } finally {
    clearTimeout(patchTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CODEX_COMPANION_PLUGIN_DATA wins over conflicting CLAUDE_PLUGIN_DATA", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const companionDataDir = path.join(tempDir, "companion");

  try {
    createFakeJob(tempDir, { id: "legacy-root-job", lines: [] });
    createFakeJob(companionDataDir, { id: "companion-root-job", lines: [] });

    const result = runCodexWatch(["--once"], tempDir, undefined, {
      CODEX_COMPANION_PLUGIN_DATA: companionDataDir
    });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job companion-root-job \| status running/);
    assert.doesNotMatch(result.stdout, /legacy-root-job/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const companionData of [null, ""]) {
  test("CLAUDE_PLUGIN_DATA is used when CODEX_COMPANION_PLUGIN_DATA is " + (companionData === null ? "unset" : "empty"), () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

    try {
      createFakeJob(tempDir, { id: "legacy-fallback-job", lines: [] });

      const result = runCodexWatch(["--once"], tempDir, undefined, {
        CODEX_COMPANION_PLUGIN_DATA: companionData
      });

      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /job legacy-fallback-job \| status running/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

for (const status of ["queued", "running"]) {
  test("once prints a failed banner after the log for a gone " + status + " worker", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
    const deadPid = await getExitedChildPid();

    try {
      createFakeJob(tempDir, {
        id: "gone-banner-job",
        status,
        pid: deadPid,
        createdAt: new Date(Date.now() - 120000).toISOString(),
        startedAt: new Date(Date.now() - 10000).toISOString(),
        lines: [event("Assistant message"), "Last worker output."]
      });
      const jsonPath = getFakeJobJsonPath(tempDir, "gone-banner-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.updatedAt = meta.startedAt;
      if (status === "queued") {
        delete meta.startedAt;
      }
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
      const originalRecord = fs.readFileSync(jsonPath, "utf8");

      const result = runCodexWatch(["--once"], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes("job gone-banner-job | status " + status));
      assert.match(result.stdout, /Last worker output\.[\s\S]*✗ failed \(worker exited\) · /);
      assert.match(result.stdout, status === "queued"
        ? /^✗ failed \(worker exited\) · 2m [0-4]s$/m
        : /^✗ failed \(worker exited\) · 1[0-4]s$/m);
      assert.strictEqual(fs.readFileSync(jsonPath, "utf8"), originalRecord);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("list displays failed with aligned columns for gone workers", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const deadPid = await getExitedChildPid();

  try {
    for (const [id, status] of [["gone-queued", "queued"], ["gone-running", "running"]]) {
      createFakeJob(tempDir, {
        id,
        status,
        pid: deadPid,
        createdAt: new Date(Date.now() - 10000).toISOString(),
        lines: []
      });
    }

    const result = runCodexWatch(["--list"], tempDir);
    const rows = result.stdout.trimEnd().split(/\r?\n/);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.match(row, /^. gone-(?:queued |running)  failed  started .* \(1[0-4]s\)$/);
    }
    assert.match(rows[0], /^\* gone-running/);
    assert.match(rows[1], /^  gone-queued/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pinned follow exits 0 when a refreshed worker is gone", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const deadPid = await getExitedChildPid();
  let patchTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "gone-pinned-job",
      pid: process.pid,
      lines: [event("Starting Codex Task.")]
    });

    const exitPromise = runFollowUntilExit(["--job", "gone-pinned-job"], tempDir);
    patchTimer = setTimeout(() => {
      fs.appendFileSync(getFakeJobLogPath(tempDir, "gone-pinned-job"), event("Assistant message") + "\nOutput before worker exit.\n");
      const jsonPath = getFakeJobJsonPath(tempDir, "gone-pinned-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.pid = deadPid;
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);

    const result = await exitPromise;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.match(result.stdout, /Output before worker exit\.[\s\S]*✗ failed \(worker exited\) · /);
    assert.strictEqual((result.stdout.match(/✗ failed \(worker exited\)/g) || []).length, 1);
  } finally {
    clearTimeout(patchTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("gone-worker follow prints one banner through terminal refresh and switches to a newer job", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const deadPid = await getExitedChildPid();
  let terminalTimer = null;
  let newerTimer = null;

  try {
    createFakeJob(tempDir, {
      id: "gone-unpinned-job",
      pid: deadPid,
      lines: []
    });

    const stdoutPromise = runFollowMode([], tempDir, 2600);
    terminalTimer = setTimeout(() => {
      const jsonPath = getFakeJobJsonPath(tempDir, "gone-unpinned-job");
      const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      meta.status = "failed";
      meta.pid = null;
      meta.completedAt = new Date().toISOString();
      fs.writeFileSync(jsonPath, JSON.stringify(meta));
    }, 600);
    newerTimer = setTimeout(() => {
      createFakeJob(tempDir, {
        id: "newer-live-job",
        createdAt: new Date().toISOString(),
        pid: process.pid,
        lines: []
      });
    }, 1400);

    const stdout = await stdoutPromise;

    assert.strictEqual((stdout.match(/^✗ /gm) || []).length, 1);
    assert.match(stdout, /^✗ failed \(worker exited\) · /m);
    assert.strictEqual((stdout.match(/job record is stale/g) || []).length, 1);
    assert.match(stdout, /job newer-live-job \| status running/);
  } finally {
    clearTimeout(terminalTimer);
    clearTimeout(newerTimer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a live running worker keeps its list status and has no completion banner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    createFakeJob(tempDir, {
      id: "live-worker-job",
      pid: process.pid,
      lines: []
    });

    const onceResult = runCodexWatch(["--once"], tempDir);
    const listResult = runCodexWatch(["--list"], tempDir);

    assert.strictEqual(onceResult.status, 0);
    assert.strictEqual(listResult.status, 0);
    assert.match(onceResult.stdout, /job live-worker-job \| status running/);
    assert.doesNotMatch(onceResult.stdout, /worker exited|job record is stale|^[✓✗]/m);
    assert.match(listResult.stdout, /^\* live-worker-job  running  started /);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const [name, request, expected] of [
  ["trimmed thread title", { threadTitle: "  Repair worker lifecycle  " }, "Repair worker lifecycle"],
  ["absent thread title", undefined, "[Claude-Orchestrated Task] prompt excerpt"],
  ["null thread title", { threadTitle: null }, "[Claude-Orchestrated Task] prompt excerpt"],
  ["whitespace-only thread title", { threadTitle: " \t " }, "[Claude-Orchestrated Task] prompt excerpt"],
  ["non-string thread title", { threadTitle: 123 }, "[Claude-Orchestrated Task] prompt excerpt"],
  ["long thread title", { threadTitle: "x".repeat(138) + "😀" + "y".repeat(20) }, "x".repeat(138) + "😀…"]
]) {
  test("list label uses " + name, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

    try {
      createFakeJob(tempDir, {
        id: "title-list-job",
        status: "completed",
        request,
        summary: "[Claude-Orchestrated Task] prompt excerpt",
        lines: []
      });

      const result = runCodexWatch(["--list"], tempDir);
      const label = result.stdout.trimEnd().split("  ").at(-1);

      assert.strictEqual(result.status, 0);
      assert.strictEqual(label, expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

for (const [name, request, suffix] of [
  ["trimmed thread title", { threadTitle: "  Repair worker lifecycle  " }, " | Repair worker lifecycle"],
  ["long thread title", { threadTitle: "x".repeat(138) + "😀" + "y".repeat(20) }, " | " + "x".repeat(138) + "😀…"],
  ["absent thread title", undefined, ""],
  ["whitespace-only thread title", { threadTitle: " \t " }, ""]
]) {
  test("header renders " + name, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

    try {
      createFakeJob(tempDir, {
        id: "title-header-job",
        createdAt: "invalid-date",
        request,
        lines: []
      });

      const result = runCodexWatch(["--once"], tempDir);
      const header = result.stdout.split(/\r?\n/)[0];

      assert.strictEqual(result.status, 0);
      assert.strictEqual(header, "job title-header-job | status running | phase running | elapsed unknown" + suffix);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
