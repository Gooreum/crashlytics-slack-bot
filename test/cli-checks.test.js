"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkGitHub, checkAnthropic, checkSlack } = require("../src/cli/init");
const { WIZARD } = require("../src/cli/messages");

const en = WIZARD.en;

function respond(status, body = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, calls };
}

test("TC-1 GitHub failures map to cause-specific fixes", async () => {
  assert.equal(await checkGitHub(respond(401).fetch, "t", "acme", "app", en), en.errors.github[401]);
  assert.equal(await checkGitHub(respond(403).fetch, "t", "acme", "app", en), en.errors.github[403]);
  assert.equal(await checkGitHub(respond(404).fetch, "t", "acme", "app", en), en.errors.github[404]("acme", "app"));
  assert.equal(await checkGitHub(respond(500).fetch, "t", "acme", "app", en), en.errors.github.other(500));
});

test("TC-2 GitHub success", async () => {
  assert.equal(await checkGitHub(respond(200).fetch, "t", "acme", "app", en), null);
});

test("TC-3 Anthropic check sends a one-token message", async () => {
  const { fetch, calls } = respond(200);
  await checkAnthropic(fetch, "sk-ant-x", en);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], "sk-ant-x");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.max_tokens, 1);
});

test("TC-4 Anthropic failures map to cause-specific fixes", async () => {
  assert.equal(await checkAnthropic(respond(401).fetch, "k", en), en.errors.anthropic[401]);
  assert.equal(await checkAnthropic(respond(403).fetch, "k", en), en.errors.anthropic[403]);
  const credit = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
  assert.equal(await checkAnthropic(respond(400, credit).fetch, "k", en), en.errors.anthropic.credit);
  assert.equal(await checkAnthropic(respond(400, { error: { message: "something else" } }).fetch, "k", en), en.errors.anthropic.other(400));
});

test("TC-5 Anthropic success, rate limit, and overload all pass", async () => {
  for (const status of [200, 429, 529]) {
    assert.equal(await checkAnthropic(respond(status).fetch, "k", en), null, String(status));
  }
});

test("TC-6 Slack error codes map to fixes", async () => {
  const slack = (body) => respond(200, body).fetch;
  assert.equal(await checkSlack(slack({ ok: true }), "xoxb-1", en), null);
  assert.equal(await checkSlack(slack({ ok: false, error: "invalid_auth" }), "xoxb-1", en), en.errors.slack.invalid_auth);
  assert.equal(await checkSlack(slack({ ok: false, error: "token_revoked" }), "xoxb-1", en), en.errors.slack.token_revoked);
  assert.equal(await checkSlack(slack({ ok: false, error: "ekm_access_denied" }), "xoxb-1", en), en.errors.slack.other("ekm_access_denied"));
  // a code that collides with a non-string key must still fall back to `other`
  assert.equal(await checkSlack(slack({ ok: false, error: "other" }), "xoxb-1", en), en.errors.slack.other("other"));
});
