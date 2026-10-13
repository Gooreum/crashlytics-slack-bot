"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ALERTS, MESSAGES, t } = require("../src/i18n");
const { createConfig } = require("../src/config");
const { SlackService } = require("../src/slack-service");
const { GitHubService } = require("../src/github-service");
const { InteractionHandler } = require("../src/interaction");
const { baseConfig, silentLogger } = require("./helpers");

function fakeSlackClient() {
  const calls = { postMessage: [], reactions: [] };
  return {
    calls,
    chat: { postMessage: async (args) => { calls.postMessage.push(args); return { ts: "111.222" }; } },
    reactions: { add: async (args) => { calls.reactions.push(args); } },
  };
}

const allText = (blocks) => JSON.stringify(blocks);

const event = {
  appId: "1:123:ios:abc",
  data: { payload: { issue: { title: "EXC_BREAKPOINT", subtitle: "Foo.swift line 3", appVersion: "1.0.0" } } },
};

test("TC-1 every language defines the same message keys", () => {
  assert.deepEqual(Object.keys(MESSAGES.ko).sort(), Object.keys(MESSAGES.en).sort());
});

test("TC-2 unknown or missing language falls back to English", () => {
  assert.equal(t(undefined), MESSAGES.en);
  assert.equal(t("fr"), MESSAGES.en);
  assert.equal(t("ko"), MESSAGES.ko);
});

test("TC-3 every alert type has an emoji and en/ko labels", () => {
  assert.deepEqual(Object.keys(ALERTS), ["fatal", "nonfatal", "regression", "velocity"]);
  for (const alert of Object.values(ALERTS)) {
    assert.ok(alert.emoji);
    assert.ok(alert.label.en);
    assert.ok(alert.label.ko);
  }
});

test("TC-4 English initial alert", async () => {
  const client = fakeSlackClient();
  const config = createConfig(baseConfig({ firebase: { projectId: "p" } }));
  const ts = await new SlackService(config, silentLogger, client).postInitialAlert(event, "New fatal issue", "🔥");
  assert.equal(ts, "111.222");
  const text = allText(client.calls.postMessage[0].blocks);
  for (const s of ["Platform", "App version", "View in Firebase Console", "🍎 iOS"]) assert.ok(text.includes(s), s);
});

test("TC-5 Korean initial alert", async () => {
  const client = fakeSlackClient();
  const config = createConfig(baseConfig({ language: "ko", firebase: { projectId: "p" } }));
  await new SlackService(config, silentLogger, client).postInitialAlert(event, "초기 치명적 문제 발생", "🔥");
  const text = allText(client.calls.postMessage[0].blocks);
  for (const s of ["플랫폼", "앱 버전", "Firebase 콘솔에서 보기"]) assert.ok(text.includes(s), s);
});

test("TC-6 English analysis thread with buttons", async () => {
  const client = fakeSlackClient();
  const config = createConfig(baseConfig());
  const sources = [{ file: "Foo.swift", filePath: "App/Foo.swift", line: 3, error: null }];
  await new SlackService(config, silentLogger, client).postAnalysisThread("111.222", "analysis", event.data.payload.issue, sources);
  const msg = client.calls.postMessage[0];
  assert.equal(msg.thread_ts, "111.222");
  const actions = msg.blocks.find((b) => b.type === "actions").elements;
  assert.equal(actions[0].text.text, "🐛 Create GitHub Issue");
  assert.equal(actions[1].text.text, "🔀 Create fix PR");
  assert.equal(actions[1].confirm.title.text, "Create a fix PR?");
  assert.equal(client.calls.reactions[0].name, "white_check_mark");
});

test("TC-7 English GitHub issue body", async () => {
  let created;
  const octokit = { rest: { issues: { create: async (args) => { created = args; return { data: { number: 1 } }; } } } };
  const config = createConfig(baseConfig());
  await new GitHubService(config, silentLogger, octokit).createIssue({ title: "Boom", subtitle: "Foo.swift", appVersion: "2.0" });
  assert.equal(created.title, "[Crash] Boom");
  assert.ok(created.body.startsWith("## Crashlytics report"));
  assert.ok(created.body.includes("**App version:** 2.0"));
  assert.deepEqual(created.labels, ["bug", "crashlytics", "auto-generated"]);
});

test("TC-8 Korean issue-created message via signed interaction", async () => {
  const posted = [];
  const services = {
    slackService: { postMessage: async (...args) => { posted.push(args); return { ts: "1" }; } },
    githubService: { createIssue: async () => ({ html_url: "https://gh/1", number: 1, title: "[Crash] Boom" }) },
    claudeService: {},
  };
  const handler = new InteractionHandler(services, silentLogger, { signingSecret: "s", language: "ko" });
  const payload = JSON.stringify({
    type: "block_actions",
    actions: [{ action_id: "create_github_issue", value: JSON.stringify({ title: "Boom" }) }],
    channel: { id: "C1" }, message: { ts: "9" },
  });
  const raw = `payload=${encodeURIComponent(payload)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", "s").update(`v0:${ts}:${raw}`).digest("hex");
  const res = { status() { return this; }, send() { return this; } };
  await handler.handle({ method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, rawBody: raw, body: { payload } }, res);
  assert.equal(posted.length, 1);
  assert.ok(posted[0][2].includes("GitHub Issue 생성 완료"));
});

test("TC-9 no Hangul left outside i18n.js in migrated files", () => {
  const files = ["src/slack-service.js", "src/github-service.js", "src/pipeline.js", "src/interaction.js", "index.js"];
  for (const file of files) {
    const content = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.equal(/[가-힣]/.test(content), false, file);
  }
});
