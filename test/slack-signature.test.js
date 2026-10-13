"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { verifySlackSignature } = require("../src/slack-signature");
const { InteractionHandler } = require("../src/interaction");
const { silentLogger } = require("./helpers");

const SECRET = "test-signing-secret";
const NOW = 1_760_000_000_000;
const NOW_SEC = NOW / 1000;

function sign(body, timestamp, secret = SECRET) {
  return "v0=" + crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";

test("TC-1 accepts a correctly signed request", () => {
  const ts = String(NOW_SEC);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: Buffer.from(body), timestamp: ts, signature: sign(body, ts), now: NOW }), true);
});

test("TC-2 rejects a signature made with another secret", () => {
  const ts = String(NOW_SEC);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: body, timestamp: ts, signature: sign(body, ts, "other"), now: NOW }), false);
});

test("TC-3 rejects a tampered body", () => {
  const ts = String(NOW_SEC);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: body + "x", timestamp: ts, signature: sign(body, ts), now: NOW }), false);
});

test("TC-4 rejects a timestamp older than 5 minutes", () => {
  const ts = String(NOW_SEC - 301);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: body, timestamp: ts, signature: sign(body, ts), now: NOW }), false);
});

test("TC-5 accepts a timestamp just under 5 minutes old", () => {
  const ts = String(NOW_SEC - 299);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: body, timestamp: ts, signature: sign(body, ts), now: NOW }), true);
});

test("TC-6 returns false for missing inputs or malformed signatures", () => {
  const ts = String(NOW_SEC);
  const valid = { signingSecret: SECRET, rawBody: body, timestamp: ts, signature: sign(body, ts), now: NOW };
  for (const key of ["signingSecret", "rawBody", "timestamp", "signature"]) {
    assert.equal(verifySlackSignature({ ...valid, [key]: undefined }), false, key);
  }
  assert.equal(verifySlackSignature({ ...valid, signature: "v0=short" }), false);
  assert.equal(verifySlackSignature({ ...valid, timestamp: "not-a-number" }), false);
});

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

function handlerWithSpies() {
  const calls = [];
  const spy = (name) => async () => { calls.push(name); return { ts: "1", html_url: "u", number: 1, title: "t" }; };
  const services = {
    slackService: { postMessage: spy("slack.postMessage"), updateMessage: spy("slack.updateMessage") },
    githubService: { createIssue: spy("github.createIssue"), fetchSource: spy("github.fetchSource"), createFixPR: spy("github.createFixPR") },
    claudeService: { generateFix: spy("claude.generateFix") },
  };
  return { handler: new InteractionHandler(services, silentLogger, { signingSecret: SECRET }), calls };
}

test("TC-7 handleSlackInteraction rejects forged requests with 401 and does nothing", async () => {
  const { handler, calls } = handlerWithSpies();
  const payload = JSON.stringify({
    type: "block_actions",
    actions: [{ action_id: "create_github_issue", value: JSON.stringify({ title: "x" }) }],
    channel: { id: "C1" }, message: { ts: "1" },
  });
  const raw = `payload=${encodeURIComponent(payload)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const req = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sign(raw, ts, "attacker") },
    rawBody: Buffer.from(raw),
    body: { payload },
  };
  const res = fakeRes();
  await handler.handle(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, []);
});

test("TC-8 handleSlackInteraction accepts signed requests", async () => {
  const { handler } = handlerWithSpies();
  const payload = JSON.stringify({ type: "view_submission" });
  const raw = `payload=${encodeURIComponent(payload)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const req = {
    method: "POST",
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign(raw, ts) },
    rawBody: Buffer.from(raw),
    body: { payload },
  };
  const res = fakeRes();
  await handler.handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "ok");
});
