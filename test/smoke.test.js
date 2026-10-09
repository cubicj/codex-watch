const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const bin = path.join(repoRoot, "bin", "codex-watch");
const slug = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
let canonicalRepoRoot = repoRoot;
try {
  canonicalRepoRoot = fs.realpathSync.native(repoRoot);
} catch (_error) {}
const stateDirName = slug + "-" + crypto.createHash("sha256").update(canonicalRepoRoot).digest("hex").slice(0, 16);

function createFakeJob(dataDir, id, threadId) {
  const jobsDir = path.join(dataDir, "state", stateDirName, "jobs");
  const createdAt = "2026-07-09T14:23:58.780Z";
  const job = {
    id,
    createdAt,
    startedAt: createdAt,
    status: "running",
    phase: "executing",
    threadId
  };

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, id + ".json"), JSON.stringify(job));
  fs.writeFileSync(path.join(jobsDir, id + ".log"), "");
}

function runCodexWatch(args, claudePluginData) {
  const stdoutPath = path.join(claudePluginData, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_COMPANION_PLUGIN_DATA: undefined,
        CLAUDE_PLUGIN_DATA: claudePluginData,
        CODEX_HOME: path.join(claudePluginData, "codex-home")
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

test("help exits 0 and prints usage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--help"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once with no jobs exits 0", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--once"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /job/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("help lists the job and list flags", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--help"], tempDir);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /--job <id>/);
    assert.match(result.stdout, /--list/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list combined with once exits 1 with usage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--list", "--once"], tempDir);

    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /Usage/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list combined with job exits 1 with usage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    const result = runCodexWatch(["--list", "--job", "some-id"], tempDir);

    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /Usage/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("job flag without a value exits 1 with usage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));

  try {
    for (const invocation of [["--job"], ["--job", "--once"]]) {
      const result = runCodexWatch(invocation, tempDir);

      assert.strictEqual(result.status, 1);
      assert.match(result.stdout, /Usage/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("once prints an existing thread id exactly once", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxw-test-"));
  const threadId = "123e4567-e89b-12d3-a456-426614174783";

  try {
    createFakeJob(tempDir, "thread-once-job", threadId);

    const result = runCodexWatch(["--once"], tempDir);
    const threadLines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("thread "));

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(threadLines, ["thread " + threadId]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
