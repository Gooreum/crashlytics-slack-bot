"use strict";

const childProcess = require("child_process");
const { CODEBASE } = require("./templates");

/**
 * Parses the JSON printed by `firebase ... --json`, ignoring any warnings printed before it.
 */
function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`Unexpected firebase output: ${stdout.trim().slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

/**
 * Thin wrapper around the firebase CLI.
 * @param {Object} [deps]
 * @param {Function} [deps.spawn] - child_process.spawn (injectable for tests)
 * @param {string} [deps.bin] - firebase executable
 */
function createFirebase({ spawn = childProcess.spawn, bin = "firebase" } = {}) {
  /**
   * Runs a firebase command. Secrets are passed via `input` (stdin), never argv.
   * With `inherit: true`, output streams to the terminal (used for deploy).
   */
  function run(args, { input, cwd, inherit = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        shell: process.platform === "win32",
        stdio: inherit ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => { stdout += d; });
      child.stderr?.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`firebase ${args[0]} failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`));
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  return {
    run,

    async isInstalled() {
      try {
        await run(["--version"]);
        return true;
      } catch {
        return false;
      }
    },

    async isLoggedIn() {
      const { result } = parseJsonOutput((await run(["login:list", "--json"])).stdout);
      return Array.isArray(result) && result.length > 0;
    },

    async listProjects() {
      const { result } = parseJsonOutput((await run(["projects:list", "--json"])).stdout);
      return (result || []).map((p) => ({ projectId: p.projectId, displayName: p.displayName || p.projectId }));
    },

    setSecret(name, value, projectId) {
      return run(
        ["functions:secrets:set", name, "--project", projectId, "--data-file", "-", "--force", "--non-interactive"],
        { input: value }
      );
    },

    async accessSecret(name, projectId) {
      const { stdout } = await run(["functions:secrets:access", name, "--project", projectId]);
      return stdout.trim();
    },

    // Interactive: firebase may ask to enable APIs or confirm changes.
    deploy(projectId, cwd) {
      return run(["deploy", "--only", `functions:${CODEBASE}`, "--project", projectId], { cwd, inherit: true });
    },
  };
}

module.exports = { createFirebase, parseJsonOutput };
