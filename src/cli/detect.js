"use strict";

const childProcess = require("child_process");

/**
 * Extracts owner/repo from a GitHub remote URL (https, ssh, or scp-style).
 * @returns {{owner: string, repo: string}|null}
 */
function parseGitHubRemote(url) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((url || "").trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

function git(args, cwd, execFileSync) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Guesses the GitHub repo from the current directory's origin remote.
 */
function detectGitHubRepo(cwd = process.cwd(), { execFileSync = childProcess.execFileSync } = {}) {
  try {
    return parseGitHubRemote(git(["remote", "get-url", "origin"], cwd, execFileSync));
  } catch {
    return null;
  }
}

/**
 * Guesses the default branch from origin/HEAD, falling back to "main".
 */
function detectDefaultBranch(cwd = process.cwd(), { execFileSync = childProcess.execFileSync } = {}) {
  try {
    return git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, execFileSync).replace(/^refs\/remotes\/origin\//, "") || "main";
  } catch {
    return "main";
  }
}

module.exports = { parseGitHubRemote, detectGitHubRepo, detectDefaultBranch };
