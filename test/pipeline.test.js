"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Pipeline } = require("../src/pipeline");
const { silentLogger } = require("./helpers");

function spies() {
  const calls = { alerts: [], analyze: [] };
  const services = {
    slackService: {
      postInitialAlert: async (event, label, emoji) => { calls.alerts.push(`${emoji} ${label}`); return "1"; },
      postAnalysisThread: async () => {},
      postMessage: async () => {},
    },
    githubService: { fetchSource: async () => [] },
    claudeService: { analyze: async (issue, label) => { calls.analyze.push(label); return "analysis"; } },
  };
  return { services, calls };
}

const event = { appId: "1:1:ios:a", data: { payload: { issue: { title: "EXC_BREAKPOINT", subtitle: "no file" } } } };

test("TC-1 alert type resolves to the English label and emoji", async () => {
  const { services, calls } = spies();
  await new Pipeline(services, silentLogger, { language: "en" }).run(event, "fatal");
  assert.deepEqual(calls.alerts, ["🔥 New fatal issue"]);
  assert.deepEqual(calls.analyze, ["New fatal issue"]);
});

test("TC-2 alert type resolves to the Korean label", async () => {
  const { services, calls } = spies();
  await new Pipeline(services, silentLogger, { language: "ko" }).run(event, "velocity");
  assert.deepEqual(calls.alerts, ["📈 반복되는 문제 (폭주 알림)"]);
});

test("TC-3 legacy (label, emoji) signature still works", async () => {
  const { services, calls } = spies();
  await new Pipeline(services, silentLogger, { language: "en" }).run(event, "커스텀 라벨", "🧪");
  assert.deepEqual(calls.alerts, ["🧪 커스텀 라벨"]);
});

test("TC-4 unknown label without emoji uses the default emoji", async () => {
  const { services, calls } = spies();
  await new Pipeline(services, silentLogger, { language: "en" }).run(event, "Some label");
  assert.deepEqual(calls.alerts, ["🚨 Some label"]);
});

test("TC-5 events without an issue stop before Slack", async () => {
  const { services, calls } = spies();
  await new Pipeline(services, silentLogger, { language: "en" }).run({ data: {} }, "fatal");
  assert.deepEqual(calls.alerts, []);
});

test("R2-TC-1 labels named like Object.prototype keys are treated as plain labels", async () => {
  for (const label of ["toString", "constructor"]) {
    const { services, calls } = spies();
    await new Pipeline(services, silentLogger, { language: "en" }).run(event, label);
    assert.deepEqual(calls.alerts, [`🚨 ${label}`]);
  }
});
