"use strict";

const silentLogger = { log() {}, warn() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    github: { owner: "acme", repo: "app", token: "ghp_test" },
    slack: { botToken: "xoxb-test", channelId: "C123", signingSecret: "signing-secret" },
    claude: { apiKey: "sk-ant-test" },
    logger: silentLogger,
    ...overrides,
  };
}

module.exports = { silentLogger, baseConfig };
