"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTest, TEST_LABEL, TEST_EMOJI } = require("../src/cli/test");
const { CONFIG_FILE } = require("../src/cli/templates");

const CONFIG = {
  github: { owner: "acme", repo: "app", branch: "main" },
  slack: { channelId: "C123" },
  firebase: { projectId: "demo", region: "us-central1" },
  platform: "ios",
  language: "en",
};

const SECRETS = {
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_SIGNING_SECRET: "sign",
  ANTHROPIC_API_KEY: "sk-ant",
  GITHUB_TOKEN: "ghp",
};

function setup({ config = CONFIG, env = {}, accessSecret, botBehavior } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "csb-test-"));
  if (config) {
    const dir = path.join(cwd, "crashlytics-slack-bot", "functions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config));
  }
  const accessed = [];
  const out = { lines: [], log: (...a) => out.lines.push(a.join(" ")), warn: (...a) => out.lines.push(a.join(" ")), error: (...a) => out.lines.push(`ERROR ${a.join(" ")}`) };
  const captured = {};
  const deps = {
    fs, cwd, env, console: out,
    firebase: {
      accessSecret: accessSecret || (async (name, projectId) => { accessed.push(`${name}@${projectId}`); return SECRETS[name]; }),
    },
    createBot: (botConfig) => {
      captured.config = botConfig;
      return {
        analyzeCrash: async (event, label, emoji) => {
          captured.call = { event, label, emoji };
          if (botBehavior) await botBehavior(botConfig);
        },
      };
    },
  };
  const run = (options = {}) => runTest({ dir: "crashlytics-slack-bot", ...options }, deps);
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { run, captured, accessed, out, cleanup };
}

test("TC-1 runs the pipeline with config and stored secrets", async () => {
  const s = setup();
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.accessed.length, 4);
    assert.ok(s.accessed.every((a) => a.endsWith("@demo")));
    const c = s.captured.config;
    assert.equal(c.github.token, "ghp");
    assert.equal(c.github.repo, "app");
    assert.equal(c.slack.botToken, "xoxb-1");
    assert.equal(c.slack.signingSecret, "sign");
    assert.equal(c.slack.channelId, "C123");
    assert.equal(c.claude.apiKey, "sk-ant");
    assert.equal(s.captured.call.label, TEST_LABEL);
    assert.equal(s.captured.call.emoji, TEST_EMOJI);
  } finally { s.cleanup(); }
});

test("TC-2 missing config points to init", async () => {
  const s = setup({ config: null });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.out.lines.some((l) => l.includes("npx crashlytics-slack-bot init")));
    assert.equal(s.accessed.length, 0);
  } finally { s.cleanup(); }
});

test("TC-3 environment variables override Secret Manager", async () => {
  const s = setup({ env: { GITHUB_TOKEN: "ghp_env" } });
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.captured.config.github.token, "ghp_env");
    assert.equal(s.accessed.some((a) => a.startsWith("GITHUB_TOKEN")), false);
  } finally { s.cleanup(); }
});

test("TC-4 unreadable secret explains the env var fallback", async () => {
  const s = setup({ accessSecret: async () => { throw new Error("PERMISSION_DENIED"); } });
  try {
    assert.equal(await s.run(), 1);
    const msg = s.out.lines.find((l) => l.startsWith("ERROR Couldn't read secret"));
    assert.ok(msg.includes("SLACK_BOT_TOKEN"));
    assert.ok(msg.includes("environment variable"));
  } finally { s.cleanup(); }
});

test("TC-5 --file/--line/--title shape the sample crash", async () => {
  const s = setup();
  try {
    await s.run({ file: "UserService.swift", line: "53", title: "EXC_BAD_ACCESS" });
    const { issue } = s.captured.call.event.data.payload;
    assert.equal(issue.title, "EXC_BAD_ACCESS");
    assert.equal(issue.subtitle, "UserService.swift line 53");
  } finally { s.cleanup(); }
});

test("TC-6 Android projects get a Kotlin sample crash", async () => {
  const s = setup({ config: { ...CONFIG, platform: "android" } });
  try {
    await s.run();
    const { event } = s.captured.call;
    assert.ok(event.appId.includes(":android:"));
    assert.equal(event.data.payload.issue.title, "java.lang.NullPointerException");
    assert.ok(event.data.payload.issue.subtitle.includes("MainActivity.kt:42"));
  } finally { s.cleanup(); }
});

test("TC-7 pipeline errors make the test fail", async () => {
  const s = setup({ botBehavior: async (cfg) => cfg.logger.error("Failed to post initial Slack alert:", "channel_not_found") });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.out.lines.some((l) => l.includes("finished with errors")));
  } finally { s.cleanup(); }
});
