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

  if (status !== "running" && status !== "queued" && status !== "pending") {
    job.completedAt = options.completedAt || createdAt;
  }

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, options.id + ".json"), JSON.stringify(job));
  fs.writeFileSync(path.join(jobsDir, options.id + ".log"), options.lines.join("\n") + "\n");

  return job;
}

function runCodexWatch(args, dataDir) {
  const stdoutPath = path.join(dataDir, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir
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

function runFollowMode(args, dataDir, durationMs) {
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
          CLAUDE_PLUGIN_DATA: dataDir
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
