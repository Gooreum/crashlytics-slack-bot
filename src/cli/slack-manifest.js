"use strict";

const { INTERACTION_FUNCTION_NAME } = require("../functions");

const DEFAULT_APP_NAME = "Crashlytics Bot";

/**
 * The Slack interactivity URL is known before deploying: the function name and region are fixed.
 */
function interactivityUrl(region, projectId) {
  return `https://${region}-${projectId}.cloudfunctions.net/${INTERACTION_FUNCTION_NAME}`;
}

/**
 * Slack app manifest with the scopes and interactivity URL the bot needs.
 */
function buildManifest({ appName = DEFAULT_APP_NAME, interactivityUrl: requestUrl }) {
  return {
    display_information: {
      name: appName,
      description: "Crashlytics alerts with AI crash analysis",
    },
    features: {
      bot_user: { display_name: appName, always_online: true },
    },
    oauth_config: {
      scopes: { bot: ["chat:write", "reactions:write"] },
    },
    settings: {
      interactivity: { is_enabled: true, request_url: requestUrl },
    },
  };
}

/**
 * A link that opens "Create app from manifest" in Slack with the manifest pre-filled.
 */
function manifestUrl(manifest) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

module.exports = { DEFAULT_APP_NAME, interactivityUrl, buildManifest, manifestUrl };
