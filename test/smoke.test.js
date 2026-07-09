const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bin = path.join(__dirname, "..", "bin", "codex-watch");

function runCodexWatch(args, claudePluginData) {
  const stdoutPath = path.join(claudePluginData, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutPath, "w");

  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: claudePluginData
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
