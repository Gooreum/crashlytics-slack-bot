"use strict";

/**
 * config 유효성 검증 및 기본값 적용
 * @param {Object} userConfig
 * @returns {Object} validated config
 */
function createConfig(userConfig) {
  if (!userConfig) throw new Error("[crashlytics-slack-bot] config가 필요합니다.");

  const { github, slack, claude, firebase, logger } = userConfig;

  if (!github?.owner) throw new Error("[crashlytics-slack-bot] config.github.owner가 필요합니다.");
  if (!github?.repo) throw new Error("[crashlytics-slack-bot] config.github.repo가 필요합니다.");
  if (!github?.token) throw new Error("[crashlytics-slack-bot] config.github.token이 필요합니다.");
  if (!slack?.botToken) throw new Error("[crashlytics-slack-bot] config.slack.botToken이 필요합니다.");
  if (!slack?.channelId) throw new Error("[crashlytics-slack-bot] config.slack.channelId가 필요합니다.");
  if (!claude?.apiKey) throw new Error("[crashlytics-slack-bot] config.claude.apiKey가 필요합니다.");

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
    },
    claude: {
      apiKey: claude.apiKey,
    },
    firebase: {
      projectId: firebase?.projectId || "",
    },
    logger: logger || console,
  };
}

module.exports = { createConfig };
