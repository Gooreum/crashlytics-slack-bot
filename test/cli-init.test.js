"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runInit } = require("../src/cli/init");

const CANCEL = Symbol("cancel");

/**
 * Fake clack UI: answers prompts in order from `answers` and records everything shown.
 */
function fakeUi(answers) {
  const queue = [...answers];
  const shown = { prompts: [], notes: [], logs: [], cancel: null, outro: null };
  const answer = (kind) => async (opts) => {
    shown.prompts.push({ kind, ...opts });
    if (queue.length === 0) throw new Error(`No answer queued for: ${opts.message}`);
    const value = queue.shift();
    if (value !== CANCEL && opts.validate) {
      const error = opts.validate(value);
      if (error) throw new Error(`Validation failed for "${opts.message}": ${error}`);
    }
    return value;
  };
  return {
    shown,
    intro() {},
    outro: (m) => { shown.outro = m; },
    cancel: (m) => { shown.cancel = m; },
    note: (m) => shown.notes.push(m),
    log: { info: (m) => shown.logs.push(m), success: (m) => shown.logs.push(m), error: (m) => shown.logs.push(`ERROR ${m}`) },
    spinner: () => ({ start() {}, stop() {} }),
    isCancel: (v) => v === CANCEL,
    select: answer("select"),
    text: answer("text"),
    password: answer("password"),
    confirm: answer("confirm"),
  };
}

const ANSWERS = [
  "demo", // project
  "asia-northeast3", // region
  "ios", // platform
  "en", // language
  "acme", "app", "main", // github owner/repo/branch
  "ghp_good", // github token
  "sk-ant-good", // anthropic key
  "xoxb-good", // slack bot token
  "signing-secret", // slack signing secret
  "C0123456789", // channel
];

function okFetch(overrides = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, status] of Object.entries(overrides)) {
      if (url.includes(match) || JSON.stringify(init).includes(match)) {
        const s = typeof status === "function" ? status() : status;
        return { ok: s < 400, status: s, json: async () => ({ ok: s < 400, error: "invalid_auth" }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetch, calls };
}

function setup({ answers = ANSWERS, firebase = {}, fetch = okFetch().fetch, options = {}, prefill } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "csb-init-"));
  if (prefill) {
    fs.mkdirSync(path.join(cwd, "crashlytics-slack-bot"));
    fs.writeFileSync(path.join(cwd, "crashlytics-slack-bot", "keep.txt"), "x");
  }
  const order = [];
  const secrets = {};
  const fb = {
    isInstalled: async () => true,
    isLoggedIn: async () => true,
    listProjects: async () => [{ projectId: "demo", displayName: "Demo" }],
    setSecret: async (name, value, projectId) => { order.push(`secret:${name}`); secrets[name] = { value, projectId }; },
    deploy: async (projectId, dir) => { order.push(`deploy:${projectId}:${path.basename(dir)}`); },
    ...firebase,
  };
  const ui = fakeUi(answers);
  const deps = {
    ui, firebase: fb, fetch, fs, cwd,
    npmInstall: async (dir) => { order.push(`npm:${path.basename(dir)}`); },
    detectRepo: () => ({ owner: "acme", repo: "app" }),
    detectBranch: () => "main",
  };
  const run = () => runInit({ dir: "crashlytics-slack-bot", "skip-deploy": false, ...options }, deps);
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { run, ui, order, secrets, cwd, cleanup };
}

test("TC-1 full setup writes files, stores secrets, then deploys", async () => {
  const s = setup();
  try {
    assert.equal(await s.run(), 0);
    const dir = path.join(s.cwd, "crashlytics-slack-bot");
    for (const f of ["firebase.json", ".firebaserc", ".gitignore", "slack-app-manifest.json", "functions/package.json", "functions/index.js", "functions/crashlytics-slack-bot.config.json"]) {
      assert.ok(fs.existsSync(path.join(dir, f)), f);
    }
    assert.deepEqual(s.secrets, {
      SLACK_BOT_TOKEN: { value: "xoxb-good", projectId: "demo" },
      SLACK_SIGNING_SECRET: { value: "signing-secret", projectId: "demo" },
      ANTHROPIC_API_KEY: { value: "sk-ant-good", projectId: "demo" },
      GITHUB_TOKEN: { value: "ghp_good", projectId: "demo" },
    });
    assert.deepEqual(s.order.slice(-2), ["npm:functions", "deploy:demo:crashlytics-slack-bot"]);
    assert.ok(s.order.indexOf("secret:GITHUB_TOKEN") < s.order.indexOf("deploy:demo:crashlytics-slack-bot"));
    assert.ok(s.ui.shown.outro.includes("npx crashlytics-slack-bot test"));
  } finally { s.cleanup(); }
});

test("TC-2 missing firebase CLI stops before any prompt", async () => {
  const s = setup({ firebase: { isInstalled: async () => false } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.cancel.includes("npm install -g firebase-tools"));
    assert.equal(s.ui.shown.prompts.length, 0);
  } finally { s.cleanup(); }
});

test("TC-3 not logged in stops with a login hint", async () => {
  const s = setup({ firebase: { isLoggedIn: async () => false } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.cancel.includes("firebase login"));
  } finally { s.cleanup(); }
});

test("TC-4 invalid GitHub token is asked again", async () => {
  const answers = [...ANSWERS];
  answers.splice(7, 1, "ghp_bad", "ghp_good");
  const fetch = okFetch({ "ghp_bad": 401 }).fetch;
  const s = setup({ answers, fetch });
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.ui.shown.prompts.filter((p) => p.message === "GitHub token").length, 2);
    assert.equal(s.ui.shown.logs.filter((l) => l.startsWith("ERROR GitHub rejected")).length, 1);
    assert.equal(s.secrets.GITHUB_TOKEN.value, "ghp_good");
  } finally { s.cleanup(); }
});

test("TC-5 --skip-deploy stops after secrets", async () => {
  const s = setup({ options: { "skip-deploy": true } });
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.order.some((o) => o.startsWith("npm") || o.startsWith("deploy")), false);
    assert.ok(s.ui.shown.outro.includes("firebase deploy --only functions:crashlytics-slack-bot --project demo"));
  } finally { s.cleanup(); }
});

test("TC-6 cancelling a prompt changes nothing", async () => {
  const s = setup({ answers: ["demo", "asia-northeast3", CANCEL] });
  try {
    assert.equal(await s.run(), 1);
    assert.equal(s.ui.shown.cancel, "Setup cancelled.");
    assert.equal(fs.existsSync(path.join(s.cwd, "crashlytics-slack-bot")), false);
    assert.deepEqual(s.order, []);
  } finally { s.cleanup(); }
});

test("TC-7 declining to overwrite a non-empty folder changes nothing", async () => {
  const s = setup({ answers: [...ANSWERS, false], prefill: true });
  try {
    assert.equal(await s.run(), 1);
    assert.deepEqual(s.order, []);
    assert.deepEqual(fs.readdirSync(path.join(s.cwd, "crashlytics-slack-bot")), ["keep.txt"]);
  } finally { s.cleanup(); }
});

test("TC-8 detected repo is offered as the default", async () => {
  const s = setup();
  try {
    await s.run();
    const owner = s.ui.shown.prompts.find((p) => p.message.startsWith("GitHub owner"));
    const repo = s.ui.shown.prompts.find((p) => p.message.startsWith("GitHub repository"));
    assert.equal(owner.initialValue, "acme");
    assert.equal(repo.initialValue, "app");
  } finally { s.cleanup(); }
});

test("TC-9 deploy failure explains how to retry", async () => {
  const s = setup({ firebase: { deploy: async () => { throw new Error("firebase deploy failed (exit 1)"); } } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.logs.includes("ERROR firebase deploy failed (exit 1)"));
    assert.ok(s.ui.shown.outro.includes("firebase deploy --only functions:crashlytics-slack-bot"));
    assert.ok(fs.existsSync(path.join(s.cwd, "crashlytics-slack-bot", "functions", "index.js")));
    assert.equal(Object.keys(s.secrets).length, 4);
  } finally { s.cleanup(); }
});

test("TC-10 Slack step shows the manifest link and interactivity URL", async () => {
  const s = setup();
  try {
    await s.run();
    const slackNote = s.ui.shown.notes.find((n) => n.includes("api.slack.com/apps?new_app=1&manifest_json="));
    assert.ok(slackNote);
    assert.ok(slackNote.includes("https://asia-northeast3-demo.cloudfunctions.net/crashlyticsSlackInteraction"));
  } finally { s.cleanup(); }
});
