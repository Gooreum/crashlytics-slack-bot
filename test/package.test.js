"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const pkg = require("../package.json");

const ROOT = path.join(__dirname, "..");
const npm = (args, cwd = ROOT) => execFileSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });

const packedFiles = (() => {
  let cache;
  return () => (cache ||= JSON.parse(npm(["pack", "--dry-run", "--json"]))[0].files.map((f) => f.path));
})();

test("TC-1 tarball contains the runtime files", () => {
  const files = packedFiles();
  for (const f of ["index.js", "bin/cli.js", "src/functions.js", "src/cli/init.js", "README.md", "LICENSE", "package.json"]) {
    assert.ok(files.includes(f), f);
  }
});

test("TC-2 tarball excludes tests and local artifacts", () => {
  for (const f of packedFiles()) {
    assert.ok(!/^(test|node_modules|\.ai-bouncer-tasks)\//.test(f) && f !== "package-lock.json", f);
  }
});

test("TC-3 package metadata is ready for npm", () => {
  assert.equal(pkg.version, "2.0.0");
  assert.equal(pkg.bin["crashlytics-slack-bot"], "bin/cli.js");
  assert.ok(pkg.repository.url.includes("github.com/Gooreum/crashlytics-slack-bot"));
  assert.ok(pkg.homepage && pkg.bugs.url);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(/[가-힣]/.test(pkg.description), false);
});

test("TC-4 tests run before publishing", () => {
  assert.equal(pkg.scripts.prepublishOnly, "npm test");
});

test("TC-5 installed tarball exposes the CLI", { timeout: 180_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-pack-"));
  try {
    const tarball = JSON.parse(npm(["pack", "--json", "--pack-destination", dir]))[0].filename;
    npm(["init", "-y"], dir);
    npm(["install", "--no-audit", "--no-fund", path.join(dir, tarball)], dir);
    const version = execFileSync(path.join(dir, "node_modules", ".bin", "crashlytics-slack-bot"), ["--version"], { encoding: "utf8" });
    assert.equal(version.trim(), "2.0.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-6 MIT license file", () => {
  const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.ok(license.startsWith("MIT License"));
  assert.ok(license.includes("Copyright (c) 2026 Gooreum"));
});
