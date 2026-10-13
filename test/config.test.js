"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfig } = require("../src/config");
const { createCrashlyticsBot } = require("../index");
const { baseConfig, silentLogger } = require("./helpers");

test("TC-1 applies defaults when only required values are given", () => {
  const config = createConfig({ ...baseConfig(), logger: undefined });
  assert.equal(config.github.branch, "main");
  assert.equal(config.language, "en");
  assert.equal(config.platform, "auto");
  assert.equal(config.claude.model, "claude-opus-5-5");
  assert.equal(config.firebase.projectId, "");
  assert.equal(config.logger, console);
});

test("TC-2 requires slack.signingSecret", () => {
  const cfg = baseConfig();
  delete cfg.slack.signingSecret;
  assert.throws(() => createConfig(cfg), /config\.slack\.signingSecret is required\./);
});

test("TC-3 reports each missing required path in English", () => {
  const cases = [
    ["github", "owner"], ["github", "repo"], ["github", "token"],
    ["slack", "botToken"], ["slack", "channelId"], ["claude", "apiKey"],
  ];
  for (const [section, key] of cases) {
    const cfg = baseConfig();
    delete cfg[section][key];
    assert.throws(() => createConfig(cfg), new RegExp(`config\\.${section}\\.${key} is required\\.`));
  }
});

test("TC-4 rejects unsupported language", () => {
  assert.throws(() => createConfig(baseConfig({ language: "fr" })), /config\.language must be one of en, ko\./);
});

test("TC-5 rejects unsupported platform", () => {
  assert.throws(() => createConfig(baseConfig({ platform: "windows" })), /config\.platform must be one of auto, ios, android\./);
});

test("TC-6 throws when config is missing", () => {
  assert.throws(() => createConfig(undefined), /config is required\./);
});

test("TC-7 keeps explicitly provided values", () => {
  const cfg = baseConfig({
    language: "ko",
    platform: "android",
    firebase: { projectId: "my-project" },
  });
  cfg.claude.model = "claude-sonnet-5-5";
  cfg.github.branch = "develop";
  const config = createConfig(cfg);
  assert.equal(config.language, "ko");
  assert.equal(config.platform, "android");
  assert.equal(config.claude.model, "claude-sonnet-5-5");
  assert.equal(config.github.branch, "develop");
  assert.equal(config.firebase.projectId, "my-project");
  assert.equal(config.slack.signingSecret, "signing-secret");
  assert.equal(config.logger, silentLogger);
});

test("TC-8 createCrashlyticsBot still returns the public handlers", () => {
  const bot = createCrashlyticsBot(baseConfig());
  assert.equal(typeof bot.analyzeCrash, "function");
  assert.equal(typeof bot.handleSlackInteraction, "function");
});
