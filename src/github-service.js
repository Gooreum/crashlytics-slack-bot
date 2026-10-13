"use strict";

const { Octokit } = require("@octokit/rest");
const { t } = require("./i18n");

const TREE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class GitHubService {
  constructor(config, logger, octokit = new Octokit({ auth: config.github.token })) {
    this.octokit = octokit;
    this.github = config.github;
    this.msg = t(config.language);
    this.logger = logger;
    this._treeCache = { files: null, timestamp: 0 };
  }

  // ── Cached git tree lookup ──────────────────────────────
  async _getTreeFiles() {
    const now = Date.now();
    if (this._treeCache.files && (now - this._treeCache.timestamp) < TREE_CACHE_TTL) {
      this.logger.log(`📂 Using cached git tree (${this._treeCache.files.length} files)`);
      return this._treeCache.files;
    }
    const { owner, repo, branch } = this.github;
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner, repo, ref: `heads/${branch}`,
    });
    const { data: tree } = await this.octokit.rest.git.getTree({
      owner, repo, tree_sha: refData.object.sha, recursive: "true",
    });
    this._treeCache.files = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
    this._treeCache.timestamp = now;
    this.logger.log(`📂 Fetched git tree: ${this._treeCache.files.length} files`);
    return this._treeCache.files;
  }

  /**
   * Fetches source files from GitHub using a hybrid strategy.
   * 1) direct path → 2) search.code → 3) git tree fallback
   * @param {Array<{file: string, line: number|null}>} fileInfo
   * @returns {Promise<Array>}
   */
  async fetchSource(fileInfo) {
    const { owner, repo, branch } = this.github;
    const results = [];

    for (const item of fileInfo) {
      const file = item.file || item.filePath;
      const line = item.line;

      if (!file) {
        this.logger.warn("⚠️ Skipping entry without a file name:", item);
        continue;
      }

      try {
        let filePath = null;

        // Strategy 1: direct lookup by full path
        if (file.includes("/")) {
          try {
            await this.octokit.rest.repos.getContent({ owner, repo, path: file, ref: branch });
            filePath = file;
            this.logger.log(`✅ [direct] ${file}`);
          } catch {
            // fall through to the next strategy
          }
        }

        // Strategy 2: search.code
        if (!filePath) {
          try {
            const searchResult = await this.octokit.rest.search.code({
              q: `filename:${file.split("/").pop()} repo:${owner}/${repo}`,
              per_page: 3,
            });
            if (searchResult.data.total_count > 0) {
              const exactMatch = searchResult.data.items.find((i) => i.path === file);
              filePath = exactMatch ? exactMatch.path : searchResult.data.items[0].path;
              this.logger.log(`✅ [search.code] ${file} → ${filePath}`);
            }
          } catch (err) {
            this.logger.warn(`⚠️ search.code failed (${file}): ${err.message}`);
          }
        }

        // Strategy 3: git tree fallback
        if (!filePath) {
          try {
            const allFiles = await this._getTreeFiles();
            const fileName = file.split("/").pop();
            const matchingPaths = allFiles.filter(
              (p) => p === file || p.endsWith(`/${fileName}`)
            );
            if (matchingPaths.length > 0) {
              filePath = matchingPaths[0];
              this.logger.log(`✅ [git tree] ${file} → ${filePath}`);
            }
          } catch (err) {
            this.logger.error(`❌ Git tree fallback failed: ${err.message}`);
          }
        }

        if (!filePath) {
          this.logger.warn(`❌ File not found: ${file}`);
          results.push({ file, line, content: null, fullContent: null, error: "File not found" });
          continue;
        }

        // File contents
        const fileContent = await this.octokit.rest.repos.getContent({
          owner, repo, path: filePath, ref: branch,
        });
        const content = Buffer.from(fileContent.data.content, "base64").toString("utf-8");
        const lines = content.split("\n");

        // ±20 lines around the crash line
        let excerpt;
        if (line) {
          const start = Math.max(0, line - 20);
          const end = Math.min(lines.length, line + 20);
          excerpt = lines.slice(start, end).map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === line ? " → " : "   ";
            return `${marker}${lineNum}: ${l}`;
          }).join("\n");
        } else {
          excerpt = lines.slice(0, 100).map((l, i) => `   ${i + 1}: ${l}`).join("\n");
        }

        // Recent commits touching the file
        let recentCommits = "";
        try {
          const commits = await this.octokit.rest.repos.listCommits({
            owner, repo, path: filePath, per_page: 5,
          });
          recentCommits = commits.data
            .map((c) => `- ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`)
            .join("\n");
        } catch {
          recentCommits = "Failed to fetch commit history";
        }

        results.push({
          file,
          filePath,
          line,
          content: excerpt,
          fullContent: content,
          sha: fileContent.data.sha,
          recentCommits,
          error: null,
        });
      } catch (error) {
        this.logger.warn(`Failed to fetch file from GitHub (${file}): ${error.message}`);
        results.push({ file, line, content: null, fullContent: null, error: error.message });
      }
    }

    return results;
  }

  /**
   * Creates a GitHub issue for the crash.
   * @param {{title, subtitle, appVersion}} crashInfo
   * @returns {Promise<Object>} created issue
   */
  async createIssue(crashInfo) {
    const { owner, repo } = this.github;
    const { data: issue } = await this.octokit.rest.issues.create({
      owner,
      repo,
      title: `[Crash] ${crashInfo.title}`,
      body: this.msg.issueBody(crashInfo),
      labels: ["bug", "crashlytics", "auto-generated"],
    });
    return issue;
  }

  /**
   * Opens a PR with the fix generated by Claude.
   * @param {{id, title, subtitle, appVersion}} issue
   * @param {{fixes, prTitle, prDescription}} fixData
   * @param {Array} sourceResults
   * @returns {Promise<Object>} created PR
   */
  async createFixPR(issue, fixData, sourceResults) {
    const { owner, repo, branch } = this.github;
    const timestamp = Date.now();
    const issueId = (issue.id || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
    const branchName = `fix/crashlytics-${issueId}-${timestamp}`;

    // 1. Latest commit SHA of the base branch
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner, repo, ref: `heads/${branch}`,
    });
    const baseSha = refData.object.sha;

    // 2. Create the fix branch
    await this.octokit.rest.git.createRef({
      owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha,
    });
    this.logger.log(`Created branch: ${branchName}`);

    // 3. Commit each fixed file
    for (const fix of fixData.fixes) {
      const sourceFile = sourceResults.find((s) => s.filePath === fix.filePath);
      const encodedContent = Buffer.from(fix.fixedCode, "utf-8").toString("base64");

      try {
        const sha = sourceFile?.sha || await this._getFileSha(fix.filePath, branchName);
        await this.octokit.rest.repos.createOrUpdateFileContents({
          owner, repo,
          path: fix.filePath,
          message: `fix: ${fix.summary}`,
          content: encodedContent,
          sha,
          branch: branchName,
        });
      } catch {
        // Retry without a SHA (new file)
        await this.octokit.rest.repos.createOrUpdateFileContents({
          owner, repo,
          path: fix.filePath,
          message: `fix: ${fix.summary}`,
          content: encodedContent,
          branch: branchName,
        });
      }

      this.logger.log(`Committed file: ${fix.filePath}`);
    }

    // 4. Open the PR
    const fixSummaries = fixData.fixes.map((f) => `- \`${f.filePath}\`: ${f.summary}`).join("\n");

    try {
      const { data: pr } = await this.octokit.rest.pulls.create({
        owner, repo,
        title: fixData.prTitle || `[Crashlytics Fix] ${issue.title}`,
        body: this.msg.prBody({ ...issue, fixSummaries, description: fixData.prDescription }),
        head: branchName,
        base: branch,
      });

      try {
        await this.octokit.rest.issues.addLabels({
          owner, repo, issue_number: pr.number,
          labels: ["bug", "crashlytics", "ai-fix"],
        });
      } catch {
        this.logger.warn("Failed to add PR labels");
      }

      this.logger.log(`Created PR: #${pr.number} ${pr.html_url}`);
      return pr;
    } catch (error) {
      // Clean up the branch on failure
      try {
        await this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
      } catch {
        // ignore
      }
      throw error;
    }
  }

  async _getFileSha(filePath, branchName) {
    const { owner, repo } = this.github;
    const { data } = await this.octokit.rest.repos.getContent({
      owner, repo, path: filePath, ref: branchName,
    });
    return data.sha;
  }
}

module.exports = { GitHubService };
