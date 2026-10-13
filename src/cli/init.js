"use strict";

const path = require("path");
const nodeFs = require("fs");
const childProcess = require("child_process");
const { createFirebase } = require("./firebase");
const { detectGitHubRepo, detectDefaultBranch } = require("./detect");
const { buildProjectFiles } = require("./templates");
const { buildManifest, interactivityUrl, manifestUrl } = require("./slack-manifest");
const { LANGUAGE_PROMPT, wizardMessages } = require("./messages");
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
  let m = wizardMessages("en");

  const ask = async (prompt) => {
    const value = await prompt;
    if (ui.isCancel(value)) throw new Cancelled();
    return value;
  };
  const required = (v) => (v ? undefined : m.required);

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
      spinner.stop(error ? m.checkFailed : m.checkOk);
      if (!error) return value;
      ui.log.error(error);
    }
  };

  try {
    // 0. Language first, so the rest of the wizard speaks it
    const language = await ask(ui.select({ message: LANGUAGE_PROMPT, options: LANGUAGE_OPTIONS }));
    m = wizardMessages(language);
    ui.intro(m.intro);

    // 1. Prerequisites
    ui.note(m.checklist.map((item) => `☐ ${item}`).join("\n"), m.checklistTitle);
    if (!(await ask(ui.confirm({ message: m.checklistConfirm, initialValue: true })))) {
      ui.cancel(m.checklistNotReady);
      return 1;
    }

    // 2. Firebase CLI
    if (!(await firebase.isInstalled())) {
      ui.cancel(m.firebaseMissing);
      return 1;
    }
    if (!(await firebase.isLoggedIn())) {
      ui.cancel(m.firebaseLogin);
      return 1;
    }
    const projects = await firebase.listProjects();
    if (projects.length === 0) {
      ui.cancel(m.noProjects);
      return 1;
    }

    // 3. Firebase project and app
    const projectId = await ask(ui.select({
      message: m.projectPrompt,
      options: projects.map((p) => ({ value: p.projectId, label: p.displayName, hint: p.projectId })),
    }));
    const region = await ask(ui.select({
      message: m.regionPrompt,
      options: REGIONS.map((r) => ({ value: r, label: r })),
      initialValue: DEFAULT_REGION,
    }));
    const platform = await ask(ui.select({
      message: m.platformPrompt,
      options: ["ios", "android", "auto"].map((value) => ({ value, label: m.platformOptions[value] })),
    }));

    // 4. GitHub
    const detected = deps.detectRepo(cwd) || {};
    const owner = await ask(ui.text({ message: m.githubOwnerPrompt, initialValue: detected.owner, validate: required }));
    const repo = await ask(ui.text({ message: m.githubRepoPrompt, initialValue: detected.repo, validate: required }));
    const branch = await ask(ui.text({ message: m.githubBranchPrompt, initialValue: deps.detectBranch(cwd), validate: required }));
    ui.note(m.githubTokenSteps(owner, repo), m.githubTokenTitle);
    const githubToken = await askValid(
      () => ui.password({ message: m.githubTokenPrompt, validate: required }),
      (token) => checkGitHub(fetch, token, owner, repo),
      m.checking.github
    );

    // 5. Anthropic
    const anthropicApiKey = await askValid(
      () => ui.password({ message: m.anthropicPrompt, validate: required }),
      (key) => checkAnthropic(fetch, key),
      m.checking.anthropic
    );

    // 6. Slack — the interactivity URL is known before deploying, so the manifest is complete.
    const requestUrl = interactivityUrl(region, projectId);
    ui.note(m.slackSteps(manifestUrl(buildManifest({ interactivityUrl: requestUrl })), requestUrl), m.slackTitle);
    const slackBotToken = await askValid(
      () => ui.password({ message: m.slackBotTokenPrompt, validate: (v) => (v?.startsWith("xoxb-") ? undefined : m.slackBotTokenFormat) }),
      (token) => checkSlack(fetch, token),
      m.checking.slack
    );
    const slackSigningSecret = await ask(ui.password({ message: m.signingSecretPrompt, validate: required }));
    const channelId = await ask(ui.text({
      message: m.channelPrompt,
      validate: (v) => (/^[CG][A-Z0-9]{6,}$/.test(v || "") ? undefined : m.channelFormat),
    }));
    ui.log.info(m.inviteBot);

    // 7. Files
    const targetDir = path.resolve(cwd, options.dir);
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      const overwrite = await ask(ui.confirm({ message: m.notEmpty(targetDir), initialValue: false }));
      if (!overwrite) {
        ui.cancel(m.cancelledNothing);
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
    ui.log.success(m.created(path.relative(cwd, targetDir) || "."));

    // 8. Secrets
    const secretValues = {
      [SECRET_NAMES.slackBotToken]: slackBotToken,
      [SECRET_NAMES.slackSigningSecret]: slackSigningSecret,
      [SECRET_NAMES.anthropicApiKey]: anthropicApiKey,
      [SECRET_NAMES.githubToken]: githubToken,
    };
    const spinner = ui.spinner();
    spinner.start(m.storingSecrets);
    for (const [name, value] of Object.entries(secretValues)) {
      await firebase.setSecret(name, value, projectId);
    }
    spinner.stop(m.secretsStored);

    // 9. Deploy
    const deployCommand = `cd ${options.dir}/functions && npm install && cd .. && firebase deploy --only functions:crashlytics-slack-bot --project ${projectId}`;
    if (options["skip-deploy"]) {
      ui.outro(m.skipDeployOutro(deployCommand));
      return 0;
    }
    try {
      await deps.npmInstall(path.join(targetDir, "functions"));
      await firebase.deploy(projectId, targetDir);
    } catch (error) {
      ui.log.error(error.message);
      ui.outro(m.deployFailed(deployCommand));
      return 1;
    }

    ui.outro(m.done(options.dir));
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) {
      ui.cancel(m.cancelled);
      return 1;
    }
    throw error;
  }
}

module.exports = { runInit, checkGitHub, checkAnthropic, checkSlack, REGIONS };
