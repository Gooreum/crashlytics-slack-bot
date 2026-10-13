"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const pkg = require("../package.json");
const { buildProjectFiles, CONFIG_FILE } = require("../src/cli/templates");
const { buildManifest, interactivityUrl, manifestUrl } = require("../src/cli/slack-manifest");

const CLI = path.join(__dirname, "..", "bin", "cli.js");
const runCli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

const answers = {
  github: { owner: "acme", repo: "app", branch: "main" },
  slack: { channelId: "C123" },
  firebase: { projectId: "demo", region: "asia-northeast3" },
  platform: "ios",
  language: "en",
};

test("TC-1 --help prints usage", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0);
  for (const s of ["Usage:", "init", "test"]) assert.ok(result.stdout.includes(s), s);
});

test("TC-2 --version prints the package version", () => {
  const result = runCli("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("TC-3 unknown commands fail with help", () => {
  const result = runCli("bogus");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Unknown command: bogus"));
  assert.ok(result.stderr.includes("Usage:"));
});

test("TC-4 project files use a dedicated codebase and createFunctions", () => {
  const files = buildProjectFiles(answers);
  const firebaseJson = JSON.parse(files["firebase.json"]);
  assert.equal(firebaseJson.functions[0].codebase, "crashlytics-slack-bot");
  assert.equal(firebaseJson.functions[0].source, "functions");
  assert.equal(JSON.parse(files[".firebaserc"]).projects.default, "demo");
  assert.ok(files["functions/index.js"].includes(`createFunctions(require("./${CONFIG_FILE}"))`));
  const fnPkg = JSON.parse(files["functions/package.json"]);
  assert.equal(fnPkg.dependencies["crashlytics-slack-bot"], `^${pkg.version}`);
});

test("TC-5 bot config holds settings but no secrets", () => {
  const config = JSON.parse(buildProjectFiles(answers)[`functions/${CONFIG_FILE}`]);
  assert.deepEqual(config, {
    github: { owner: "acme", repo: "app", branch: "main" },
    slack: { channelId: "C123" },
    firebase: { projectId: "demo", region: "asia-northeast3" },
    platform: "ios",
    language: "en",
  });
  assert.equal(/token|secret|apiKey/i.test(JSON.stringify(config)), false);
});

test("TC-6 generated functions/index.js loads and exports the functions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-"));
  try {
    const files = buildProjectFiles(answers);
    const fnDir = path.join(dir, "functions");
    fs.mkdirSync(fnDir);
    fs.writeFileSync(path.join(fnDir, CONFIG_FILE), files[`functions/${CONFIG_FILE}`]);
    // Point the generated require("crashlytics-slack-bot") at this checkout.
    const indexJs = files["functions/index.js"].replace('require("crashlytics-slack-bot")', `require(${JSON.stringify(path.join(__dirname, ".."))})`);
    fs.writeFileSync(path.join(fnDir, "index.js"), indexJs);
    const exported = require(path.join(fnDir, "index.js"));
    assert.equal(Object.keys(exported).length, 6);
    assert.ok(exported.crashlyticsSlackInteraction);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-7 manifest carries the interactivity URL and scopes", () => {
  const url = interactivityUrl("asia-northeast3", "demo");
  assert.equal(url, "https://asia-northeast3-demo.cloudfunctions.net/crashlyticsSlackInteraction");
  const manifest = buildManifest({ interactivityUrl: url });
  assert.equal(manifest.settings.interactivity.request_url, url);
  assert.deepEqual(manifest.oauth_config.scopes.bot, ["chat:write", "reactions:write"]);
});

test("TC-8 manifest URL round-trips", () => {
  const manifest = buildManifest({ interactivityUrl: "https://x" });
  const link = manifestUrl(manifest);
  const prefix = "https://api.slack.com/apps?new_app=1&manifest_json=";
  assert.ok(link.startsWith(prefix));
  assert.deepEqual(JSON.parse(decodeURIComponent(link.slice(prefix.length))), manifest);
});
