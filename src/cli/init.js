"use strict";

const path = require("path");
const nodeFs = require("fs");
const childProcess = require("child_process");
const { createFirebase } = require("./firebase");
const { detectGitHubRepo, detectDefaultBranch } = require("./detect");
const { buildProjectFiles } = require("./templates");
const { buildManifest, interactivityUrl, manifestUrl } = require("./slack-manifest");
const { SECRET_NAMES, DEFAULT_REGION } = require("../functions");
const { LANGUAGE_OPTIONS } = require("../i18n");

const REGIONS = [
  DEFAULT_REGION, "us-east1", "us-west1", "europe-west1", "europe-west3",
  "asia-northeast1", "asia-northeast3", "asia-southeast1", "australia-southeast1",
];

class Cancelled extends Error {}

// ── Credential checks (each returns null when valid, or an error message) ──

async function checkGitHub(fetch, token, owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.ok) return null;
  return res.status === 404
    ? `Repository ${owner}/${repo} not found, or the token can't access it.`
    : `GitHub rejected the token (HTTP ${res.status}).`;
}

async function checkAnthropic(fetch, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  return res.ok ? null : `Anthropic rejected the API key (HTTP ${res.status}).`;
}

async function checkSlack(fetch, botToken) {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const body = await res.json().catch(() => ({}));
  return body.ok ? null : `Slack rejected the bot token (${body.error || `HTTP ${res.status}`}).`;
}

function npmInstall(cwd) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("npm", ["install", "--no-audit", "--no-fund"], {
      cwd, stdio: "inherit", shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code})`))));
  });
}

function defaultDeps() {
  return {
    ui: require("@clack/prompts"),
    firebase: createFirebase(),
    fetch: globalThis.fetch,
    fs: nodeFs,
    cwd: process.cwd(),
    npmInstall,
    detectRepo: detectGitHubRepo,
    detectBranch: detectDefaultBranch,
  };
}

/**
 * Interactive setup: collects settings, writes the Firebase project, stores secrets, deploys.
 * @param {{dir: string, "skip-deploy": boolean}} options
 * @param {Object} [deps] - injectable for tests
 * @returns {Promise<number>} exit code
 */
async function runInit(options, deps = defaultDeps()) {
  const { ui, firebase, fetch, fs, cwd } = deps;

  const ask = async (prompt) => {
    const value = await prompt;
    if (ui.isCancel(value)) throw new Cancelled();
    return value;
  };

  // Ask until `check` accepts the value (check returns an error message or null).
  const askValid = async (makePrompt, check, checkingMessage) => {
    for (;;) {
      const value = await ask(makePrompt());
      const spinner = ui.spinner();
      spinner.start(checkingMessage);
      let error;
      try {
        error = await check(value);
      } catch (e) {
        error = e.message;
      }
      spinner.stop(error ? "Check failed" : "Looks good");
      if (!error) return value;
      ui.log.error(error);
    }
  };

  ui.intro("crashlytics-slack-bot setup");

  try {
    // 1. Firebase CLI
    if (!(await firebase.isInstalled())) {
      ui.cancel("Firebase CLI not found. Install it with: npm install -g firebase-tools");
      return 1;
    }
    if (!(await firebase.isLoggedIn())) {
      ui.cancel("You're not logged in to Firebase. Run: firebase login");
      return 1;
    }
    const projects = await firebase.listProjects();
    if (projects.length === 0) {
      ui.cancel("No Firebase projects found. Create one at https://console.firebase.google.com");
      return 1;
    }

    // 2. Firebase project and app
    const projectId = await ask(ui.select({
      message: "Firebase project",
      options: projects.map((p) => ({ value: p.projectId, label: p.displayName, hint: p.projectId })),
    }));
    const region = await ask(ui.select({
      message: "Cloud Functions region",
      options: REGIONS.map((r) => ({ value: r, label: r })),
      initialValue: DEFAULT_REGION,
    }));
    const platform = await ask(ui.select({
      message: "App platform",
      options: [
        { value: "ios", label: "iOS (Swift / Objective-C)" },
        { value: "android", label: "Android (Kotlin / Java)" },
        { value: "auto", label: "Both — detect from each alert" },
      ],
    }));
    const language = await ask(ui.select({
      message: "Language for Slack messages and AI analysis",
      options: LANGUAGE_OPTIONS,
    }));

    // 3. GitHub
    const detected = deps.detectRepo(cwd) || {};
    const owner = await ask(ui.text({ message: "GitHub owner (user or organization)", initialValue: detected.owner, validate: (v) => (v ? undefined : "Required") }));
    const repo = await ask(ui.text({ message: "GitHub repository with the app's source code", initialValue: detected.repo, validate: (v) => (v ? undefined : "Required") }));
    const branch = await ask(ui.text({ message: "Base branch for fix PRs", initialValue: deps.detectBranch(cwd), validate: (v) => (v ? undefined : "Required") }));
    ui.note(
      "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new\n" +
      `Repository access: ${owner}/${repo}\n` +
      "Permissions: Contents (read & write), Pull requests (read & write), Issues (read & write)",
      "GitHub token"
    );
    const githubToken = await askValid(
      () => ui.password({ message: "GitHub token", validate: (v) => (v ? undefined : "Required") }),
      (token) => checkGitHub(fetch, token, owner, repo),
      "Checking GitHub access…"
    );

    // 4. Anthropic
    const anthropicApiKey = await askValid(
      () => ui.password({ message: "Anthropic API key (https://console.anthropic.com/settings/keys)", validate: (v) => (v ? undefined : "Required") }),
      (key) => checkAnthropic(fetch, key),
      "Checking Anthropic API key…"
    );

    // 5. Slack — the interactivity URL is known before deploying, so the manifest is complete.
    const requestUrl = interactivityUrl(region, projectId);
    ui.note(
      `1. Create the Slack app from this pre-filled manifest:\n   ${manifestUrl(buildManifest({ interactivityUrl: requestUrl }))}\n` +
      "2. Click \"Install to Workspace\".\n" +
      "3. Copy the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information).\n" +
      `Interactivity URL (already in the manifest): ${requestUrl}`,
      "Slack app"
    );
    const slackBotToken = await askValid(
      () => ui.password({ message: "Slack Bot User OAuth Token (xoxb-…)", validate: (v) => (v?.startsWith("xoxb-") ? undefined : "Bot tokens start with xoxb-") }),
      (token) => checkSlack(fetch, token),
      "Checking Slack token…"
    );
    const slackSigningSecret = await ask(ui.password({ message: "Slack Signing Secret", validate: (v) => (v ? undefined : "Required") }));
    const channelId = await ask(ui.text({
      message: "Slack channel ID for alerts (channel details → bottom, e.g. C0123456789)",
      validate: (v) => (/^[CG][A-Z0-9]{6,}$/.test(v || "") ? undefined : "Channel IDs look like C0123456789"),
    }));
    ui.log.info("Invite the bot to that channel: /invite @Crashlytics Bot");

    // 6. Files
    const targetDir = path.resolve(cwd, options.dir);
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      const overwrite = await ask(ui.confirm({ message: `${targetDir} is not empty. Overwrite generated files?`, initialValue: false }));
      if (!overwrite) {
        ui.cancel("Setup cancelled — nothing was changed.");
        return 1;
      }
    }
    const files = buildProjectFiles({
      github: { owner, repo, branch },
      slack: { channelId },
      firebase: { projectId, region },
      platform,
      language,
    });
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(targetDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    ui.log.success(`Created ${path.relative(cwd, targetDir) || "."}/`);

    // 7. Secrets
    const secretValues = {
      [SECRET_NAMES.slackBotToken]: slackBotToken,
      [SECRET_NAMES.slackSigningSecret]: slackSigningSecret,
      [SECRET_NAMES.anthropicApiKey]: anthropicApiKey,
      [SECRET_NAMES.githubToken]: githubToken,
    };
    const spinner = ui.spinner();
    spinner.start("Storing secrets in Secret Manager…");
    for (const [name, value] of Object.entries(secretValues)) {
      await firebase.setSecret(name, value, projectId);
    }
    spinner.stop("Secrets stored");

    // 8. Deploy
    const deployCommand = `cd ${options.dir}/functions && npm install && cd .. && firebase deploy --only functions:crashlytics-slack-bot --project ${projectId}`;
    if (options["skip-deploy"]) {
      ui.outro(`Files and secrets are ready. Deploy when you're ready:\n  ${deployCommand}`);
      return 0;
    }
    ui.log.info("Cloud Functions require the Blaze (pay-as-you-go) plan on your Firebase project.");
    try {
      await deps.npmInstall(path.join(targetDir, "functions"));
      await firebase.deploy(projectId, targetDir);
    } catch (error) {
      ui.log.error(error.message);
      ui.outro(`Deployment failed. Fix the error above, then run:\n  ${deployCommand}`);
      return 1;
    }

    ui.outro(
      "Done! New Crashlytics alerts will show up in Slack.\n" +
      `Send a test alert now: npx crashlytics-slack-bot test --dir ${options.dir}`
    );
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) {
      ui.cancel("Setup cancelled.");
      return 1;
    }
    throw error;
  }
}

module.exports = { runInit, checkGitHub, checkAnthropic, checkSlack, REGIONS };
