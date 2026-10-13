"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const pkg = require("../index");

const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("TC-1 README has the main sections", () => {
  for (const heading of ["## Quick start", "## How it works", "## Manual setup", "## Configuration", "## Security"]) {
    assert.ok(readme.includes(heading), heading);
  }
  assert.ok(readme.includes("npx crashlytics-slack-bot init"));
});

test("TC-2 every name imported in README examples is exported", () => {
  const imports = [...readme.matchAll(/const \{([^}]+)\} = require\("crashlytics-slack-bot"\)/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
  assert.ok(imports.length >= 2);
  for (const name of imports) assert.ok(name in pkg, name);
});

test("TC-3 every secret is documented", () => {
  for (const name of Object.values(pkg.SECRET_NAMES)) assert.ok(readme.includes(name), name);
});

test("TC-4 every deployed function is documented", () => {
  const names = [...Object.values(pkg.ALERT_TRIGGERS).map((t) => t.exportName), "crashlyticsSlackInteraction"];
  for (const name of names) assert.ok(readme.includes(`\`${name}\``), name);
});

test("TC-5 configuration table covers every option", () => {
  for (const key of ["github.owner", "github.repo", "github.branch", "slack.channelId", "firebase.region", "firebase.appId", "platform", "language", "alerts", "claude.model"]) {
    assert.ok(readme.includes(`| \`${key}\``), key);
  }
});

test("TC-6 README is in English", () => {
  assert.equal(/[가-힣]/.test(readme), false);
});

test("S3-TC-1 Quick start describes the language choice, checklist, and per-question steps", () => {
  const quickStart = readme.split("## Quick start")[1].split("## How it works")[0];
  for (const phrase of ["language (English or Korean)", "checklist of prerequisites", "numbered steps", "how to fix it"]) {
    assert.ok(quickStart.includes(phrase), phrase);
  }
});

test("S3-TC-2 Anthropic row says credits are required and checked", () => {
  const row = readme.split("\n").find((line) => line.startsWith("| Anthropic API key"));
  assert.ok(row.includes("Requires credits"));
  assert.ok(row.includes("has credits"));
});
