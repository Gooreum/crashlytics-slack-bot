"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runInit } = require("../src/cli/init");
const { WIZARD, LANGUAGE_PROMPT } = require("../src/cli/messages");

const CANCEL = Symbol("cancel");

/**
 * Fake clack UI: answers prompts in order from `answers` and records everything shown.
 */
function fakeUi(answers) {
  const queue = [...answers];
  const shown = { prompts: [], notes: [], logs: [], timeline: [], cancel: null, outro: null };
  const answer = (kind) => async (opts) => {
    shown.prompts.push({ kind, ...opts });
    shown.timeline.push({ type: "prompt", text: opts.message });
    if (queue.length === 0) throw new Error(`No answer queued for: ${opts.message}`);
    const value = queue.shift();
    if (value !== CANCEL && opts.validate) {
      const error = opts.validate(value);
      if (error) throw new Error(`Validation failed for "${opts.message}": ${error}`);
    }
    return value;
  };
  return {
    shown,
    intro() {},
    outro: (m) => { shown.outro = m; },
    cancel: (m) => { shown.cancel = m; },
    note: (m) => { shown.notes.push(m); shown.timeline.push({ type: "note", text: m }); },
    log: { info: (m) => { shown.logs.push(m); shown.timeline.push({ type: "log", text: m }); }, success: (m) => shown.logs.push(m), error: (m) => shown.logs.push(`ERROR ${m}`) },
    spinner: () => ({ start() {}, stop() {} }),
    isCancel: (v) => v === CANCEL,
    select: answer("select"),
    text: answer("text"),
    password: answer("password"),
    confirm: answer("confirm"),
  };
}

const ANSWERS = [
  "en", // language
  true, // checklist ready
  "demo", // project
  "asia-northeast3", // region
  "ios", // platform
  "acme", "app", "main", // github owner/repo/branch
  "ghp_good", // github token
  "sk-ant-good", // anthropic key
  "xoxb-good", // slack bot token
  "signing-secret", // slack signing secret
  "C0123456789", // channel
];

function okFetch(overrides = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, status] of Object.entries(overrides)) {
      if (url.includes(match) || JSON.stringify(init).includes(match)) {
        const s = typeof status === "function" ? status() : status;
        return { ok: s < 400, status: s, json: async () => ({ ok: s < 400, error: "invalid_auth" }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetch, calls };
}

function setup({ answers = ANSWERS, firebase = {}, fetch = okFetch().fetch, options = {}, prefill } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "csb-init-"));
  if (prefill) {
    fs.mkdirSync(path.join(cwd, "crashlytics-slack-bot"));
    fs.writeFileSync(path.join(cwd, "crashlytics-slack-bot", "keep.txt"), "x");
  }
  const order = [];
  const secrets = {};
  const fb = {
    isInstalled: async () => true,
    isLoggedIn: async () => true,
    listProjects: async () => [{ projectId: "demo", displayName: "Demo" }],
    setSecret: async (name, value, projectId) => { order.push(`secret:${name}`); secrets[name] = { value, projectId }; },
    deploy: async (projectId, dir) => { order.push(`deploy:${projectId}:${path.basename(dir)}`); },
    ...firebase,
  };
  const ui = fakeUi(answers);
  const deps = {
    ui, firebase: fb, fetch, fs, cwd,
    npmInstall: async (dir) => { order.push(`npm:${path.basename(dir)}`); },
    detectRepo: () => ({ owner: "acme", repo: "app" }),
    detectBranch: () => "main",
  };
  const run = () => runInit({ dir: "crashlytics-slack-bot", "skip-deploy": false, ...options }, deps);
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { run, ui, order, secrets, cwd, cleanup };
}

test("TC-1 full setup writes files, stores secrets, then deploys", async () => {
  const s = setup();
  try {
    assert.equal(await s.run(), 0);
    const dir = path.join(s.cwd, "crashlytics-slack-bot");
    for (const f of ["firebase.json", ".firebaserc", ".gitignore", "slack-app-manifest.json", "functions/package.json", "functions/index.js", "functions/crashlytics-slack-bot.config.json"]) {
      assert.ok(fs.existsSync(path.join(dir, f)), f);
    }
    assert.deepEqual(s.secrets, {
      SLACK_BOT_TOKEN: { value: "xoxb-good", projectId: "demo" },
      SLACK_SIGNING_SECRET: { value: "signing-secret", projectId: "demo" },
      ANTHROPIC_API_KEY: { value: "sk-ant-good", projectId: "demo" },
      GITHUB_TOKEN: { value: "ghp_good", projectId: "demo" },
    });
    assert.deepEqual(s.order.slice(-2), ["npm:functions", "deploy:demo:crashlytics-slack-bot"]);
    assert.ok(s.order.indexOf("secret:GITHUB_TOKEN") < s.order.indexOf("deploy:demo:crashlytics-slack-bot"));
    assert.ok(s.ui.shown.outro.includes("npx crashlytics-slack-bot test"));
  } finally { s.cleanup(); }
});

test("TC-2 missing firebase CLI stops before any setup question", async () => {
  const s = setup({ firebase: { isInstalled: async () => false } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.cancel.includes("npm install -g firebase-tools"));
    // only the language and checklist questions come before the Firebase check
    assert.equal(s.ui.shown.prompts.length, 2);
  } finally { s.cleanup(); }
});

test("TC-3 not logged in stops with a login hint", async () => {
  const s = setup({ firebase: { isLoggedIn: async () => false } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.cancel.includes("firebase login"));
  } finally { s.cleanup(); }
});

test("TC-4 invalid GitHub token is asked again", async () => {
  const answers = [...ANSWERS];
  answers.splice(8, 1, "ghp_bad", "ghp_good");
  const fetch = okFetch({ "ghp_bad": 401 }).fetch;
  const s = setup({ answers, fetch });
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.ui.shown.prompts.filter((p) => p.message === "GitHub token").length, 2);
    assert.equal(s.ui.shown.logs.filter((l) => l.startsWith("ERROR GitHub rejected")).length, 1);
    assert.equal(s.secrets.GITHUB_TOKEN.value, "ghp_good");
  } finally { s.cleanup(); }
});

test("TC-5 --skip-deploy stops after secrets", async () => {
  const s = setup({ options: { "skip-deploy": true } });
  try {
    assert.equal(await s.run(), 0);
    assert.equal(s.order.some((o) => o.startsWith("npm") || o.startsWith("deploy")), false);
    assert.ok(s.ui.shown.outro.includes("firebase deploy --only functions:crashlytics-slack-bot --project demo"));
  } finally { s.cleanup(); }
});

test("TC-6 cancelling a prompt changes nothing", async () => {
  const s = setup({ answers: ["en", true, "demo", "asia-northeast3", CANCEL] });
  try {
    assert.equal(await s.run(), 1);
    assert.equal(s.ui.shown.cancel, "Setup cancelled.");
    assert.equal(fs.existsSync(path.join(s.cwd, "crashlytics-slack-bot")), false);
    assert.deepEqual(s.order, []);
  } finally { s.cleanup(); }
});

test("TC-7 declining to overwrite a non-empty folder changes nothing", async () => {
  const s = setup({ answers: [...ANSWERS, false], prefill: true });
  try {
    assert.equal(await s.run(), 1);
    assert.deepEqual(s.order, []);
    assert.deepEqual(fs.readdirSync(path.join(s.cwd, "crashlytics-slack-bot")), ["keep.txt"]);
  } finally { s.cleanup(); }
});

test("TC-8 detected repo is offered as the default", async () => {
  const s = setup();
  try {
    await s.run();
    const owner = s.ui.shown.prompts.find((p) => p.message.startsWith("GitHub owner"));
    const repo = s.ui.shown.prompts.find((p) => p.message.startsWith("GitHub repository"));
    assert.equal(owner.initialValue, "acme");
    assert.equal(repo.initialValue, "app");
  } finally { s.cleanup(); }
});

test("TC-9 deploy failure explains how to retry", async () => {
  const s = setup({ firebase: { deploy: async () => { throw new Error("firebase deploy failed (exit 1)"); } } });
  try {
    assert.equal(await s.run(), 1);
    assert.ok(s.ui.shown.logs.includes("ERROR firebase deploy failed (exit 1)"));
    assert.ok(s.ui.shown.outro.includes("firebase deploy --only functions:crashlytics-slack-bot"));
    assert.ok(fs.existsSync(path.join(s.cwd, "crashlytics-slack-bot", "functions", "index.js")));
    assert.equal(Object.keys(s.secrets).length, 4);
  } finally { s.cleanup(); }
});

test("TC-10 Slack step shows the manifest link and interactivity URL", async () => {
  const s = setup();
  try {
    await s.run();
    const slackNote = s.ui.shown.notes.find((n) => n.includes("api.slack.com/apps?new_app=1&manifest_json="));
    assert.ok(slackNote);
    assert.ok(slackNote.includes("https://asia-northeast3-demo.cloudfunctions.net/crashlyticsSlackInteraction"));
  } finally { s.cleanup(); }
});

// ── Language first + checklist ──

test("S2-TC-1 the first question is the bilingual language prompt", async () => {
  const s = setup();
  try {
    await s.run();
    assert.equal(s.ui.shown.prompts[0].kind, "select");
    assert.equal(s.ui.shown.prompts[0].message, LANGUAGE_PROMPT);
  } finally { s.cleanup(); }
});

test("S2-TC-2 the checklist is shown and confirmed right after the language", async () => {
  const s = setup();
  try {
    await s.run();
    const checklist = s.ui.shown.notes[0];
    assert.equal(checklist.split("☐").length - 1, 5);
    assert.equal(s.ui.shown.prompts[1].kind, "confirm");
    assert.equal(s.ui.shown.prompts[1].message, WIZARD.en.checklistConfirm);
  } finally { s.cleanup(); }
});

test("S2-TC-3 declining the checklist stops without touching anything", async () => {
  let firebaseCalled = false;
  const s = setup({ answers: ["en", false], firebase: { isInstalled: async () => { firebaseCalled = true; return true; } } });
  try {
    assert.equal(await s.run(), 1);
    assert.equal(s.ui.shown.cancel, WIZARD.en.checklistNotReady);
    assert.equal(firebaseCalled, false);
    assert.deepEqual(s.order, []);
    assert.equal(fs.existsSync(path.join(s.cwd, "crashlytics-slack-bot")), false);
  } finally { s.cleanup(); }
});

test("S2-TC-4 Korean wizard speaks Korean end to end", async () => {
  const s = setup({ answers: ["ko", ...ANSWERS.slice(1)] });
  try {
    assert.equal(await s.run(), 0);
    const ko = WIZARD.ko;
    const hangul = /[가-힣]/;
    // every prompt after the bilingual language question is Korean
    for (const p of s.ui.shown.prompts.slice(1)) assert.ok(hangul.test(p.message), p.message);
    assert.ok(s.ui.shown.notes[0].includes(ko.checklist[0]));
    assert.equal(s.ui.shown.outro, ko.done("crashlytics-slack-bot"));
    assert.ok(s.ui.shown.logs.includes(ko.inviteBot));
    const config = JSON.parse(fs.readFileSync(path.join(s.cwd, "crashlytics-slack-bot", "functions", "crashlytics-slack-bot.config.json"), "utf8"));
    assert.equal(config.language, "ko");
  } finally { s.cleanup(); }
});

test("S2-TC-6 Blaze is no longer announced right before deploying", async () => {
  const s = setup();
  try {
    await s.run();
    assert.equal(s.ui.shown.logs.some((l) => l.includes("Blaze")), false);
    assert.ok(s.ui.shown.notes[0].includes("Blaze"));
  } finally { s.cleanup(); }
});

// ── Step-by-step guides right before each question ──

function noteBefore(timeline, promptMessage) {
  const i = timeline.findIndex((e) => e.type === "prompt" && e.text === promptMessage);
  assert.ok(i > 0, `prompt not found: ${promptMessage}`);
  assert.equal(timeline[i - 1].type, "note", `no note right before: ${promptMessage}`);
  return timeline[i - 1].text;
}

for (const language of ["en", "ko"]) {
  const m = WIZARD[language];
  const tag = language === "en" ? "" : " (ko, P2S1-TC-6)";

  test(`P2S1-TC-1 region help precedes the region question${tag}`, async () => {
    const s = setup({ answers: [language, ...ANSWERS.slice(1)] });
    try {
      await s.run();
      const note = noteBefore(s.ui.shown.timeline, m.regionPrompt);
      assert.equal(note, m.regionHelp);
      assert.ok(note.includes("asia-northeast3"));
    } finally { s.cleanup(); }
  });

  test(`P2S1-TC-2 GitHub token steps precede the token question${tag}`, async () => {
    const s = setup({ answers: [language, ...ANSWERS.slice(1)] });
    try {
      await s.run();
      const note = noteBefore(s.ui.shown.timeline, m.githubTokenPrompt);
      assert.equal(note, m.githubTokenSteps("acme", "app"));
      for (const word of ["acme", "app", "Expiration", "Pending requests"]) assert.ok(note.includes(word), word);
    } finally { s.cleanup(); }
  });

  test(`P2S1-TC-3 Anthropic steps precede the key question${tag}`, async () => {
    const s = setup({ answers: [language, ...ANSWERS.slice(1)] });
    try {
      await s.run();
      const note = noteBefore(s.ui.shown.timeline, m.anthropicPrompt);
      assert.equal(note, m.anthropicSteps);
      assert.ok(note.includes("Billing") && note.includes("sk-ant-"));
    } finally { s.cleanup(); }
  });

  test(`P2S1-TC-4 Slack app steps precede the bot token question${tag}`, async () => {
    const s = setup({ answers: [language, ...ANSWERS.slice(1)] });
    try {
      await s.run();
      const note = noteBefore(s.ui.shown.timeline, m.slackBotTokenPrompt);
      for (const word of ["Request to Install", "Show", "api.slack.com/apps?new_app=1", "crashlyticsSlackInteraction"]) {
        assert.ok(note.includes(word), word);
      }
    } finally { s.cleanup(); }
  });

  test(`P2S1-TC-5 channel steps precede the channel question, invite hint follows${tag}`, async () => {
    const s = setup({ answers: [language, ...ANSWERS.slice(1)] });
    try {
      await s.run();
      const { timeline } = s.ui.shown;
      assert.equal(noteBefore(timeline, m.channelPrompt), m.channelSteps);
      const i = timeline.findIndex((e) => e.type === "prompt" && e.text === m.channelPrompt);
      assert.deepEqual(timeline[i + 1], { type: "log", text: m.inviteBot });
    } finally { s.cleanup(); }
  });
}
