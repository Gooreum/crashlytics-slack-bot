"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { createFirebase } = require("../src/cli/firebase");
const { parseGitHubRemote, detectDefaultBranch } = require("../src/cli/detect");

/**
 * Fake spawn: `respond(args)` returns { code, stdout, stderr } or { error }.
 */
function fakeSpawn(respond) {
  const calls = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { bin, args, stdin: "" };
    calls.push(call);
    child.stdin = { end: (data) => { call.stdin += data; } };
    setImmediate(() => {
      const r = respond(args);
      if (r.error) return child.emit("error", r.error);
      if (r.stdout) child.stdout.emit("data", r.stdout);
      if (r.stderr) child.stderr.emit("data", r.stderr);
      child.emit("close", r.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

test("TC-1 setSecret passes the value on stdin only", async () => {
  const { spawn, calls } = fakeSpawn(() => ({}));
  await createFirebase({ spawn }).setSecret("SLACK_BOT_TOKEN", "xoxb-1", "demo");
  assert.deepEqual(calls[0].args, ["functions:secrets:set", "SLACK_BOT_TOKEN", "--project", "demo", "--data-file", "-", "--force", "--non-interactive"]);
  assert.equal(calls[0].stdin, "xoxb-1");
  assert.equal(calls[0].args.includes("xoxb-1"), false);
});

test("TC-2 missing firebase binary means not installed", async () => {
  const { spawn } = fakeSpawn(() => ({ error: Object.assign(new Error("spawn firebase ENOENT"), { code: "ENOENT" }) }));
  assert.equal(await createFirebase({ spawn }).isInstalled(), false);
});

test("TC-3 project list parses JSON after warnings", async () => {
  const stdout = '(node:1) [DEP0040] DeprecationWarning\n{"status":"success","result":[{"projectId":"demo","displayName":"Demo"},{"projectId":"other"}]}';
  const { spawn } = fakeSpawn(() => ({ stdout }));
  assert.deepEqual(await createFirebase({ spawn }).listProjects(), [
    { projectId: "demo", displayName: "Demo" },
    { projectId: "other", displayName: "other" },
  ]);
});

test("TC-4 login detection", async () => {
  const loggedOut = fakeSpawn(() => ({ stdout: '{"status":"success"}' }));
  assert.equal(await createFirebase({ spawn: loggedOut.spawn }).isLoggedIn(), false);
  const loggedIn = fakeSpawn(() => ({ stdout: '{"status":"success","result":[{"user":{"email":"a@b.c"}}]}' }));
  assert.equal(await createFirebase({ spawn: loggedIn.spawn }).isLoggedIn(), true);
});

test("TC-5 non-zero exit rejects with stderr", async () => {
  const { spawn } = fakeSpawn(() => ({ code: 1, stderr: "Error: permission denied" }));
  await assert.rejects(createFirebase({ spawn }).run(["deploy"]), /firebase deploy failed \(exit 1\): Error: permission denied/);
});

test("TC-6 accessSecret trims the value", async () => {
  const { spawn, calls } = fakeSpawn(() => ({ stdout: "value\n" }));
  assert.equal(await createFirebase({ spawn }).accessSecret("GITHUB_TOKEN", "demo"), "value");
  assert.deepEqual(calls[0].args, ["functions:secrets:access", "GITHUB_TOKEN", "--project", "demo"]);
});

test("TC-7 parses GitHub remotes in every common form", () => {
  for (const url of [
    "https://github.com/acme/app.git",
    "https://github.com/acme/app",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "https://ghp_secret@github.com/acme/app.git",
  ]) {
    assert.deepEqual(parseGitHubRemote(url), { owner: "acme", repo: "app" }, url);
  }
});

test("TC-8 non-GitHub or empty remotes return null", () => {
  assert.equal(parseGitHubRemote("https://gitlab.com/a/b.git"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("TC-9 default branch detection with fallback", () => {
  assert.equal(detectDefaultBranch(".", { execFileSync: () => "refs/remotes/origin/develop\n" }), "develop");
  assert.equal(detectDefaultBranch(".", { execFileSync: () => { throw new Error("no origin/HEAD"); } }), "main");
});
