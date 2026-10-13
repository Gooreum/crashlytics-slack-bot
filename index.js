"use strict";

const { createConfig } = require("./src/config");
const { GitHubService } = require("./src/github-service");
const { ClaudeService } = require("./src/claude-service");
const { SlackService } = require("./src/slack-service");
const { Pipeline } = require("./src/pipeline");
const { InteractionHandler } = require("./src/interaction");

/**
 * Creates a Crashlytics Slack bot instance.
 *
 * @param {Object} config
 * @param {Object} config.github
 * @param {string} config.github.owner        - GitHub organization or user
 * @param {string} config.github.repo         - Repository name
 * @param {string} [config.github.branch]     - Base branch (default: "main")
 * @param {string} config.github.token        - GitHub personal access token
 * @param {Object} config.slack
 * @param {string} config.slack.botToken      - Slack bot OAuth token
 * @param {string} config.slack.channelId     - Slack channel ID
 * @param {string} config.slack.signingSecret - Slack app signing secret
 * @param {Object} config.claude
 * @param {string} config.claude.apiKey       - Anthropic API key
 * @param {string} [config.claude.model]      - Claude model (default: "claude-opus-5-5")
 * @param {Object} [config.firebase]
 * @param {string} [config.firebase.projectId] - Firebase project ID (for console links)
 * @param {"auto"|"ios"|"android"} [config.platform] - App platform (default: "auto")
 * @param {"en"|"ko"} [config.language]       - Message language (default: "en")
 * @param {Object} [config.logger]            - Custom logger (default: console)
 *
 * @returns {{
 *   analyzeCrash: (event, typeLabel, emoji) => Promise<void>,
 *   handleSlackInteraction: (req, res) => Promise<void>
 * }}
 */
function createCrashlyticsBot(config) {
  const validatedConfig = createConfig(config);
  const logger = validatedConfig.logger;

  const services = {
    githubService: new GitHubService(validatedConfig, logger),
    claudeService: new ClaudeService(validatedConfig, logger),
    slackService: new SlackService(validatedConfig, logger),
  };

  const pipeline = new Pipeline(services, logger, validatedConfig);
  const interactionHandler = new InteractionHandler(services, logger, {
    signingSecret: validatedConfig.slack.signingSecret,
    language: validatedConfig.language,
  });

  return {
    /**
     * Runs the crash analysis pipeline.
     * Crashlytics event → Slack alert → GitHub source lookup → Claude analysis → Slack thread
     */
    analyzeCrash: (event, typeLabel, emoji) => pipeline.run(event, typeLabel, emoji),

    /**
     * Handles Slack button interactions (req, res handler).
     */
    handleSlackInteraction: (req, res) => interactionHandler.handle(req, res),
  };
}

module.exports = { createCrashlyticsBot };
