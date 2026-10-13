"use strict";

const { createConfig } = require("./src/config");
const { GitHubService } = require("./src/github-service");
const { ClaudeService } = require("./src/claude-service");
const { SlackService } = require("./src/slack-service");
const { Pipeline } = require("./src/pipeline");
const { InteractionHandler } = require("./src/interaction");

/**
 * Crashlytics Slack Bot 인스턴스를 생성합니다.
 *
 * @param {Object} config
 * @param {Object} config.github
 * @param {string} config.github.owner    - GitHub organization 또는 사용자명
 * @param {string} config.github.repo     - 레포지토리 이름
 * @param {string} config.github.branch   - 기본 브랜치 (기본값: "main")
 * @param {string} config.github.token    - GitHub Personal Access Token
 * @param {Object} config.slack
 * @param {string} config.slack.botToken  - Slack Bot OAuth Token
 * @param {string} config.slack.channelId - Slack 채널 ID
 * @param {Object} config.claude
 * @param {string} config.claude.apiKey   - Anthropic API Key
 * @param {Object} [config.firebase]
 * @param {string} [config.firebase.projectId] - Firebase 프로젝트 ID (콘솔 링크용)
 * @param {Object} [config.logger]        - 커스텀 로거 (기본값: console)
 *
 * @returns {{
 *   analyzeCrash: (event, typeLabel, emoji) => Promise<void>,
 *   handleSlackInteraction: (req, res) => Promise<void>
 * }}
 *
 * @example
 * // Firebase Cloud Functions
 * const { createCrashlyticsBot } = require('crashlytics-slack-bot');
 *
 * exports.postFatalToSlack = onNewFatalIssuePublished(secrets, async (event) => {
 *   const bot = createCrashlyticsBot({
 *     github: { owner: 'myorg', repo: 'myapp', branch: 'main', token: GITHUB_TOKEN.value() },
 *     slack: { botToken: SLACK_BOT_TOKEN.value(), channelId: 'C0123456' },
 *     claude: { apiKey: ANTHROPIC_KEY.value() },
 *     firebase: { projectId: 'my-firebase-project' },
 *   });
 *   await bot.analyzeCrash(event, '초기 치명적 문제 발생', '🔥');
 * });
 *
 * exports.slackInteraction = onRequest(secrets, async (req, res) => {
 *   const bot = createCrashlyticsBot({ ... });
 *   await bot.handleSlackInteraction(req, res);
 * });
 */
function createCrashlyticsBot(config) {
  const validatedConfig = createConfig(config);
  const logger = validatedConfig.logger;

  const services = {
    githubService: new GitHubService(validatedConfig, logger),
    claudeService: new ClaudeService(validatedConfig, logger),
    slackService: new SlackService(validatedConfig, logger),
  };

  const pipeline = new Pipeline(services, logger);
  const interactionHandler = new InteractionHandler(services, logger, validatedConfig.slack);

  return {
    /**
     * 크래시 분석 파이프라인을 실행합니다.
     * Crashlytics 이벤트 → Slack 알림 → GitHub 소스 조회 → Claude 분석 → Slack 쓰레드
     */
    analyzeCrash: (event, typeLabel, emoji) => pipeline.run(event, typeLabel, emoji),

    /**
     * Slack 버튼 인터랙션을 처리합니다. (req, res 핸들러)
     */
    handleSlackInteraction: (req, res) => interactionHandler.handle(req, res),
  };
}

module.exports = { createCrashlyticsBot };
