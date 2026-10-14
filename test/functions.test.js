"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../index");
const { createFunctions } = pkg;

const options = (overrides = {}) => ({
  github: { owner: "acme", repo: "app", branch: "main" },
  slack: { channelId: "C123" },
  firebase: { projectId: "demo", region: "asia-northeast3" },
  ...overrides,
});

const ALL = [
  "crashlyticsNewFatal", "crashlyticsNewNonfatal", "crashlyticsRegression",
  "crashlyticsVelocity", "crashlyticsNewAnr", "crashlyticsSlackInteraction",
];

test("TC-1 exports every function by default", () => {
  assert.deepEqual(Object.keys(createFunctions(options())).sort(), [...ALL].sort());
});

test("TC-2 alerts option limits the triggers", () => {
  assert.deepEqual(Object.keys(createFunctions(options({ alerts: ["fatal"] }))), ["crashlyticsNewFatal", "crashlyticsSlackInteraction"]);
});

test("TC-3 region is applied to every function", () => {
  for (const fn of Object.values(createFunctions(options()))) {
    assert.deepEqual(fn.__endpoint.region, ["asia-northeast3"]);
  }
});

test("TC-4 every function receives the four secrets", () => {
  const expected = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"];
  for (const fn of Object.values(createFunctions(options()))) {
    assert.deepEqual(fn.__endpoint.secretEnvironmentVariables.map((s) => s.key).sort(), expected);
  }
});

test("TC-5 appId filters Crashlytics triggers", () => {
  const fns = createFunctions(options({ firebase: { region: "us-central1", appId: "1:2:ios:3" } }));
  const filters = fns.crashlyticsNewFatal.__endpoint.eventTrigger.eventFilters;
  assert.equal(filters.appid, "1:2:ios:3");
  assert.equal(filters.alerttype, "crashlytics.newFatalIssue");
  assert.equal(fns.crashlyticsNewAnr.__endpoint.eventTrigger.eventFilters.alerttype, "crashlytics.newAnrIssue");
});

test("TC-6 unknown alert types are rejected", () => {
  assert.throws(() => createFunctions(options({ alerts: ["fatal", "bogus"] })), /Unknown alert type: bogus/);
});

test("TC-7 default region is us-central1", () => {
  const fns = createFunctions(options({ firebase: {} }));
  assert.deepEqual(fns.crashlyticsSlackInteraction.__endpoint.region, ["us-central1"]);
});

test("TC-8 package index exposes the public API", () => {
  assert.equal(typeof pkg.createCrashlyticsBot, "function");
  assert.equal(typeof pkg.createFunctions, "function");
  assert.equal(pkg.SECRET_NAMES.slackSigningSecret, "SLACK_SIGNING_SECRET");
  assert.ok(pkg.ALERT_TRIGGERS.fatal);
});

// ── Bot reuse and default logger ──

const SECRET_ENV = {
  SLACK_BOT_TOKEN: "xoxb-env", SLACK_SIGNING_SECRET: "sign-env",
  ANTHROPIC_API_KEY: "sk-ant-env", GITHUB_TOKEN: "ghp-env",
};

async function invokeInteraction(fns, times) {
  const saved = {};
  for (const [k, v] of Object.entries(SECRET_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    for (let i = 0; i < times; i++) {
      await fns.crashlyticsSlackInteraction(
        { method: "POST", url: "/", headers: {}, body: {}, get: () => undefined, header: () => undefined },
        { status() { return this; }, send() { return this; }, setHeader() {}, getHeader() {}, on() {}, end() {} }
      );
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function spyBot() {
  const spy = { created: [], handled: 0 };
  spy.createBot = (config) => {
    spy.created.push(config);
    return { handleSlackInteraction: async () => { spy.handled++; }, analyzeCrash: async () => {} };
  };
  return spy;
}

test("R1-TC-1 the bot is built once and reused across invocations", async () => {
  const spy = spyBot();
  await invokeInteraction(createFunctions(options(), { createBot: spy.createBot }), 2);
  assert.equal(spy.created.length, 1);
  assert.equal(spy.handled, 2);
});

test("R1-TC-2 the default logger is firebase-functions/logger", async () => {
  const spy = spyBot();
  await invokeInteraction(createFunctions(options(), { createBot: spy.createBot }), 1);
  assert.equal(spy.created[0].logger, require("firebase-functions/logger"));
});

test("R1-TC-3 a custom logger is kept", async () => {
  const spy = spyBot();
  const logger = { log() {}, warn() {}, error() {} };
  await invokeInteraction(createFunctions(options({ logger }), { createBot: spy.createBot }), 1);
  assert.equal(spy.created[0].logger, logger);
});

test("R1-TC-4 secrets are mapped into the bot config", async () => {
  const spy = spyBot();
  await invokeInteraction(createFunctions(options(), { createBot: spy.createBot }), 1);
  const c = spy.created[0];
  assert.equal(c.github.token, "ghp-env");
  assert.equal(c.slack.botToken, "xoxb-env");
  assert.equal(c.slack.signingSecret, "sign-env");
  assert.equal(c.claude.apiKey, "sk-ant-env");
  assert.equal(c.slack.channelId, "C123");
});
