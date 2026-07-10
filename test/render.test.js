const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const bin = path.join(repoRoot, "bin", "codex-watch");
const timestamp = "2026-07-09T14:23:58.780Z";

function event(value) {
  return "[" + timestamp + "] " + value;
}

function createFakeJob(dataDir, options) {
  const slug = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const jobsDir = path.join(dataDir, "state", slug + "-0123456789abcdef", "jobs");
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

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, options.id + ".json"), JSON.stringify(job));
  fs.writeFileSync(path.join(jobsDir, options.id + ".log"), options.lines.join("\n") + "\n");

  return job;
}

function createFakeRollout(codexHome, threadId, turnContexts) {
  const sessionsDir = path.join(codexHome, "sessions", "2026", "07", "09");
  const entries = [
    { timestamp, type: "session_meta", payload: { id: threadId } },
    ...turnContexts.map((payload) => ({ timestamp, type: "turn_context", payload }))
  ];

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-07-09T23-23-59-" + threadId + ".jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
}

function getFakeJobLogPath(dataDir, id) {
  const stateRoot = path.join(dataDir, "state");
  const stateDir = fs.readdirSync(stateRoot)[0];
  return path.join(stateRoot, stateDir, "jobs", id + ".log");
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

test("once omits session info when no rollout exists", () => {
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
