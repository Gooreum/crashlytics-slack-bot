"use strict";

const path = require("path");
const nodeFs = require("fs");
const { createFirebase } = require("./firebase");
const { CONFIG_FILE } = require("./templates");
const { SECRET_NAMES } = require("../functions");

const TEST_LABEL = "Test alert from crashlytics-slack-bot";
const TEST_EMOJI = "🧪";

/**
 * Builds a Crashlytics-shaped event for a sample crash.
 * @param {string} platform - "ios" | "android" | "auto"
 * @param {{file?: string, line?: string|number, title?: string}} overrides
 * @param {string} [appId]
 */
function sampleEvent(platform, { file, line, title } = {}, appId) {
  const android = platform === "android";
  const issue = android
    ? {
      title: title || "java.lang.NullPointerException",
      subtitle: `com.example.MainActivity.onCreate (${file || "MainActivity.kt"}:${line || 42})`,
    }
    : {
      title: title || "EXC_BREAKPOINT",
      subtitle: `${file || "AppDelegate.swift"} line ${line || 1}`,
    };
  return {
    appId: appId || `1:0:${android ? "android" : "ios"}:test`,
    data: { payload: { issue: { id: "TEST", appVersion: "test", ...issue } } },
  };
}

function defaultDeps() {
  const { createCrashlyticsBot } = require("../../index");
  return {
    firebase: createFirebase(),
    fs: nodeFs,
    cwd: process.cwd(),
    env: process.env,
    console,
    createBot: createCrashlyticsBot,
  };
}

/**
 * Sends a sample crash through the full pipeline from this machine,
 * using the config written by `init` and the secrets stored in Secret Manager.
 * @returns {Promise<number>} exit code
 */
async function runTest(options, deps = defaultDeps()) {
  const { firebase, fs, cwd, env, console: out } = deps;

  const configPath = path.resolve(cwd, options.dir, "functions", CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    out.error(`No config found at ${configPath}.\nRun \`npx crashlytics-slack-bot init\` first, or pass --dir <folder created by init>.`);
    return 1;
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const projectId = config.firebase?.projectId;

  // Environment variables win, so the test also works without Secret Manager access.
  const secrets = {};
  for (const [key, name] of Object.entries(SECRET_NAMES)) {
    if (env[name]) {
      secrets[key] = env[name];
      continue;
    }
    try {
      secrets[key] = await firebase.accessSecret(name, projectId);
    } catch (error) {
      out.error(`Couldn't read secret ${name} from project ${projectId}: ${error.message}\nSet the ${name} environment variable to use a local value instead.`);
      return 1;
    }
  }

  let errors = 0;
  const logger = {
    log: (...args) => out.log(...args),
    warn: (...args) => out.warn(...args),
    error: (...args) => { errors++; out.error(...args); },
  };

  const bot = deps.createBot({
    ...config,
    github: { ...config.github, token: secrets.githubToken },
    slack: { ...config.slack, botToken: secrets.slackBotToken, signingSecret: secrets.slackSigningSecret },
    claude: { ...config.claude, apiKey: secrets.anthropicApiKey },
    logger,
  });

  out.log(`Sending a test alert to Slack channel ${config.slack.channelId}…`);
  await bot.analyzeCrash(sampleEvent(config.platform, options, config.firebase?.appId), TEST_LABEL, TEST_EMOJI);

  if (errors > 0) {
    out.error("\nThe test finished with errors (see above).");
    return 1;
  }
  out.log("\nDone! Check the Slack thread for Claude's analysis, then try the Issue/PR buttons to test the deployed function.");
  return 0;
}

module.exports = { runTest, sampleEvent, TEST_LABEL, TEST_EMOJI };
