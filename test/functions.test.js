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
