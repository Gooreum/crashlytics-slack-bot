"use strict";

const LANGUAGES = ["en", "ko"];
const PLATFORMS = ["auto", "ios", "android"];
const DEFAULT_MODEL = "claude-opus-5-5";

function fail(message) {
  throw new Error(`[crashlytics-slack-bot] ${message}`);
}

function required(value, path) {
  if (!value) fail(`config.${path} is required.`);
}

function oneOf(value, allowed, path) {
  if (value !== undefined && !allowed.includes(value)) {
    fail(`config.${path} must be one of ${allowed.join(", ")}.`);
  }
}

/**
 * config 유효성 검증 및 기본값 적용
 * @param {Object} userConfig
 * @returns {Object} validated config
 */
function createConfig(userConfig) {
  if (!userConfig) fail("config is required.");

  const { github, slack, claude, firebase, platform, language, logger } = userConfig;

  required(github?.owner, "github.owner");
  required(github?.repo, "github.repo");
  required(github?.token, "github.token");
  required(slack?.botToken, "slack.botToken");
  required(slack?.channelId, "slack.channelId");
  required(slack?.signingSecret, "slack.signingSecret");
  required(claude?.apiKey, "claude.apiKey");
  oneOf(language, LANGUAGES, "language");
  oneOf(platform, PLATFORMS, "platform");

  return {
    github: {
      owner: github.owner,
      repo: github.repo,
      branch: github.branch || "main",
      token: github.token,
    },
    slack: {
      botToken: slack.botToken,
      channelId: slack.channelId,
      signingSecret: slack.signingSecret,
    },
    claude: {
      apiKey: claude.apiKey,
      model: claude.model || DEFAULT_MODEL,
    },
    firebase: {
      projectId: firebase?.projectId || "",
    },
    platform: platform || "auto",
    language: language || "en",
    logger: logger || console,
  };
}

module.exports = { createConfig, LANGUAGES, PLATFORMS, DEFAULT_MODEL };
