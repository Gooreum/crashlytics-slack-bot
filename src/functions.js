"use strict";

/**
 * Crashlytics alert types → exported Cloud Function name and firebase-functions v2 trigger.
 */
const ALERT_TRIGGERS = {
  fatal: { exportName: "crashlyticsNewFatal", trigger: "onNewFatalIssuePublished" },
  nonfatal: { exportName: "crashlyticsNewNonfatal", trigger: "onNewNonfatalIssuePublished" },
  regression: { exportName: "crashlyticsRegression", trigger: "onRegressionAlertPublished" },
  velocity: { exportName: "crashlyticsVelocity", trigger: "onVelocityAlertPublished" },
  anr: { exportName: "crashlyticsNewAnr", trigger: "onNewAnrIssuePublished" },
};

/** Secret Manager names read by the deployed functions. */
const SECRET_NAMES = {
  slackBotToken: "SLACK_BOT_TOKEN",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  githubToken: "GITHUB_TOKEN",
};

const INTERACTION_FUNCTION_NAME = "crashlyticsSlackInteraction";
const DEFAULT_REGION = "us-central1";

/**
 * Builds every Cloud Function the bot needs. Use it as your functions entry point:
 *
 *   module.exports = createFunctions({ github: {...}, slack: { channelId }, firebase: { region } });
 *
 * Secrets are read from Secret Manager (see SECRET_NAMES), so the config only holds
 * non-secret values.
 *
 * @param {Object} options - Same as createCrashlyticsBot's config, minus tokens/keys, plus:
 * @param {Array<keyof ALERT_TRIGGERS>} [options.alerts] - Alert types to subscribe to (default: all)
 * @param {string} [options.firebase.region] - Functions region (default: "us-central1")
 * @param {string} [options.firebase.appId] - Only handle alerts for this Firebase app
 * @returns {Object<string, Function>} Cloud Functions keyed by export name
 */
function createFunctions(options = {}, { createBot } = {}) {
  // firebase-functions is a peer dependency, so load it only when needed.
  const { defineSecret } = require("firebase-functions/params");
  const { onRequest } = require("firebase-functions/v2/https");
  const crashlytics = require("firebase-functions/v2/alerts/crashlytics");
  const build = createBot || require("../index").createCrashlyticsBot;

  const alerts = options.alerts || Object.keys(ALERT_TRIGGERS);
  const unknown = alerts.filter((key) => !ALERT_TRIGGERS[key]);
  if (unknown.length > 0) {
    throw new Error(`[crashlytics-slack-bot] Unknown alert type: ${unknown.join(", ")}`);
  }

  const secrets = Object.fromEntries(
    Object.entries(SECRET_NAMES).map(([key, name]) => [key, defineSecret(name)])
  );
  const baseOptions = {
    region: options.firebase?.region || DEFAULT_REGION,
    secrets: Object.values(secrets),
    timeoutSeconds: 300,
    memory: "512MiB",
  };

  // secret.value() only works inside a running function, so build the bot on first use.
  // Reusing it keeps per-instance caches (e.g. the GitHub file tree) warm across invocations.
  let bot;
  const getBot = () => (bot ||= build({
    ...options,
    github: { ...options.github, token: secrets.githubToken.value() },
    slack: {
      ...options.slack,
      botToken: secrets.slackBotToken.value(),
      signingSecret: secrets.slackSigningSecret.value(),
    },
    claude: { ...options.claude, apiKey: secrets.anthropicApiKey.value() },
    logger: options.logger || require("firebase-functions/logger"),
  }));

  const alertOptions = {
    ...baseOptions,
    ...(options.firebase?.appId ? { appId: options.firebase.appId } : {}),
  };

  const functions = {};
  for (const key of alerts) {
    const { exportName, trigger } = ALERT_TRIGGERS[key];
    functions[exportName] = crashlytics[trigger](alertOptions, (event) => getBot().analyzeCrash(event, key));
  }
  functions[INTERACTION_FUNCTION_NAME] = onRequest(baseOptions, (req, res) => getBot().handleSlackInteraction(req, res));
  return functions;
}

module.exports = { createFunctions, ALERT_TRIGGERS, SECRET_NAMES, INTERACTION_FUNCTION_NAME, DEFAULT_REGION };
