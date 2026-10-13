"use strict";

const pkg = require("../../package.json");
const { buildManifest, interactivityUrl } = require("./slack-manifest");

const CODEBASE = "crashlytics-slack-bot";
const CONFIG_FILE = "crashlytics-slack-bot.config.json";
const NODE_RUNTIME = "22";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Non-secret bot settings written to functions/crashlytics-slack-bot.config.json.
 * Tokens and keys live in Secret Manager, never in this file.
 */
function renderBotConfig(answers) {
  return {
    github: { owner: answers.github.owner, repo: answers.github.repo, branch: answers.github.branch },
    slack: { channelId: answers.slack.channelId },
    firebase: {
      projectId: answers.firebase.projectId,
      region: answers.firebase.region,
      ...(answers.firebase.appId ? { appId: answers.firebase.appId } : {}),
    },
    platform: answers.platform,
    language: answers.language,
  };
}

/**
 * Every file `init` writes, keyed by path relative to the target directory.
 * A separate functions codebase keeps `firebase deploy` from touching the project's other functions.
 */
function buildProjectFiles(answers) {
  const url = interactivityUrl(answers.firebase.region, answers.firebase.projectId);
  return {
    "firebase.json": json({
      functions: [
        {
          source: "functions",
          codebase: CODEBASE,
          ignore: ["node_modules", ".git", "firebase-debug.log", "firebase-debug.*.log", "*.local"],
        },
      ],
    }),
    ".firebaserc": json({ projects: { default: answers.firebase.projectId } }),
    ".gitignore": "node_modules/\n*.local\nfirebase-debug.log*\n",
    "slack-app-manifest.json": json(buildManifest({ appName: answers.slack.appName, interactivityUrl: url })),
    "functions/package.json": json({
      name: "crashlytics-slack-bot-functions",
      private: true,
      main: "index.js",
      engines: { node: NODE_RUNTIME },
      dependencies: {
        "crashlytics-slack-bot": `^${pkg.version}`,
        "firebase-admin": pkg.devDependencies["firebase-admin"],
        "firebase-functions": pkg.devDependencies["firebase-functions"],
      },
    }),
    "functions/index.js": `"use strict";

const { createFunctions } = require("crashlytics-slack-bot");

module.exports = createFunctions(require("./${CONFIG_FILE}"));
`,
    [`functions/${CONFIG_FILE}`]: json(renderBotConfig(answers)),
  };
}

module.exports = { CODEBASE, CONFIG_FILE, buildProjectFiles, renderBotConfig };
