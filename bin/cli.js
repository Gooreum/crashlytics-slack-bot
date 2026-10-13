#!/usr/bin/env node
"use strict";

const { parseArgs } = require("node:util");
const pkg = require("../package.json");

const HELP = `crashlytics-slack-bot v${pkg.version}

Crashlytics alerts in Slack, analyzed by Claude, with one-click GitHub issues and fix PRs.

Usage:
  npx crashlytics-slack-bot init [--dir <path>] [--skip-deploy]
      Set up Slack, GitHub, and Claude, then deploy the Cloud Functions.

  npx crashlytics-slack-bot test [--dir <path>] [--file <name>] [--line <n>] [--title <text>]
      Send a sample crash through the pipeline from your machine.

Options:
  --dir <path>     Project folder created by init (default: ./crashlytics-slack-bot)
  --skip-deploy    Write files and secrets but don't run firebase deploy
  --file <name>    Source file for the sample crash (e.g. UserService.swift)
  --line <n>       Line number for the sample crash
  --title <text>   Crash title for the sample crash
  -h, --help       Show this help
  -v, --version    Show the version
`;

const OPTIONS = {
  dir: { type: "string", default: "crashlytics-slack-bot" },
  "skip-deploy": { type: "boolean", default: false },
  file: { type: "string" },
  line: { type: "string" },
  title: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }

  // Load commands lazily so --help stays fast.
  if (command === "init") return require("../src/cli/init").runInit(values);
  if (command === "test") return require("../src/cli/test").runTest(values);

  console.error(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  }
);
