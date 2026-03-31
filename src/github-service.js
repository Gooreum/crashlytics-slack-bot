"use strict";

const { Octokit } = require("@octokit/rest");

const TREE_CACHE_TTL = 5 * 60 * 1000; // 5분

class GitHubService {
  constructor(config, logger) {
    this.octokit = new Octokit({ auth: config.github.token });
    this.github = config.github;
    this.logger = logger;
    this._treeCache = { files: null, timestamp: 0 };
  }

  // ── Git Tree 캐시 조회 ──────────────────────────────────
  async _getTreeFiles() {
    const now = Date.now();
    if (this._treeCache.files && (now - this._treeCache.timestamp) < TREE_CACHE_TTL) {
      this.logger.log(`📂 Git Tree 캐시 사용 (${this._treeCache.files.length}개 파일)`);
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
    this.logger.log(`📂 Git Tree 신규 조회: ${this._treeCache.files.length}개 파일`);
    return this._treeCache.files;
  }

  /**
   * 하이브리드 전략으로 GitHub에서 소스 코드를 조회합니다.
   * 1차: 직접 경로 조회 → 2차: search.code → 3차: Git Tree 폴백
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
        this.logger.warn("⚠️ 파일명이 없는 항목 건너뜀:", item);
        continue;
      }

      try {
        let filePath = null;

        // 전략 1: 전체 경로 직접 조회
        if (file.includes("/")) {
          try {
            await this.octokit.rest.repos.getContent({ owner, repo, path: file, ref: branch });
            filePath = file;
            this.logger.log(`✅ [직접조회] ${file}`);
          } catch {
            // 다음 전략으로
          }
        }

        // 전략 2: search.code
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
            this.logger.warn(`⚠️ search.code 실패 (${file}): ${err.message}`);
          }
        }

        // 전략 3: Git Tree 폴백
        if (!filePath) {
          try {
            const allFiles = await this._getTreeFiles();
            const fileName = file.split("/").pop();
            const matchingPaths = allFiles.filter(
              (p) => p === file || p.endsWith(`/${fileName}`)
            );
            if (matchingPaths.length > 0) {
              filePath = matchingPaths[0];
              this.logger.log(`✅ [Git Tree 폴백] ${file} → ${filePath}`);
            }
          } catch (err) {
            this.logger.error(`❌ Git Tree 폴백도 실패: ${err.message}`);
          }
        }

        if (!filePath) {
          this.logger.warn(`❌ 파일 못 찾음: ${file}`);
          results.push({ file, line, content: null, fullContent: null, error: "파일을 찾을 수 없음" });
          continue;
        }

        // 파일 내용 조회
        const fileContent = await this.octokit.rest.repos.getContent({
          owner, repo, path: filePath, ref: branch,
        });
        const content = Buffer.from(fileContent.data.content, "base64").toString("utf-8");
        const lines = content.split("\n");

        // 크래시 라인 주변 ±20줄 추출
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

        // 최근 커밋 이력
        let recentCommits = "";
        try {
          const commits = await this.octokit.rest.repos.listCommits({
            owner, repo, path: filePath, per_page: 5,
          });
          recentCommits = commits.data
            .map((c) => `- ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`)
            .join("\n");
        } catch {
          recentCommits = "커밋 이력 조회 실패";
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
        this.logger.warn(`GitHub 파일 조회 실패 (${file}): ${error.message}`);
        results.push({ file, line, content: null, fullContent: null, error: error.message });
      }
    }

    return results;
  }

  /**
   * GitHub Issue를 생성합니다.
   * @param {{title, subtitle, appVersion}} crashInfo
   * @returns {Promise<Object>} 생성된 이슈
   */
  async createIssue(crashInfo) {
    const { owner, repo } = this.github;
    const { data: issue } = await this.octokit.rest.issues.create({
      owner,
      repo,
      title: `[Crash] ${crashInfo.title}`,
      body: `## Crashlytics 자동 리포트

**에러:** \`${crashInfo.title}\`
**상세:** \`${crashInfo.subtitle}\`
**앱 버전:** ${crashInfo.appVersion}

---

> 이 이슈는 Crashlytics AI 분석 봇에 의해 자동 생성되었습니다.
> Slack 쓰레드에서 AI 분석 결과를 확인하세요.`,
      labels: ["bug", "crashlytics", "auto-generated"],
    });
    return issue;
  }

  /**
   * Claude가 생성한 수정 코드로 GitHub PR을 생성합니다.
   * @param {{id, title, subtitle, appVersion}} issue
   * @param {{fixes, prTitle, prDescription}} fixData
   * @param {Array} sourceResults
   * @returns {Promise<Object>} 생성된 PR
   */
  async createFixPR(issue, fixData, sourceResults) {
    const { owner, repo, branch } = this.github;
    const timestamp = Date.now();
    const issueId = (issue.id || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
    const branchName = `fix/crashlytics-${issueId}-${timestamp}`;

    // Step 1: base 브랜치 최신 커밋 SHA
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner, repo, ref: `heads/${branch}`,
    });
    const baseSha = refData.object.sha;

    // Step 2: 새 브랜치 생성
    await this.octokit.rest.git.createRef({
      owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha,
    });
    this.logger.log(`브랜치 생성: ${branchName}`);

    // Step 3: 수정 파일 커밋
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
        // SHA 없이 새 파일로 생성 시도
        await this.octokit.rest.repos.createOrUpdateFileContents({
          owner, repo,
          path: fix.filePath,
          message: `fix: ${fix.summary}`,
          content: encodedContent,
          branch: branchName,
        });
      }

      this.logger.log(`파일 커밋: ${fix.filePath}`);
    }

    // Step 4: PR 생성
    const fixSummaries = fixData.fixes.map((f) => `- \`${f.filePath}\`: ${f.summary}`).join("\n");

    try {
      const { data: pr } = await this.octokit.rest.pulls.create({
        owner, repo,
        title: fixData.prTitle || `[Crashlytics Fix] ${issue.title}`,
        body: `## 🤖 AI 자동 크래시 수정 PR

### 크래시 정보
- **에러:** \`${issue.title || "N/A"}\`
- **상세:** \`${issue.subtitle || "N/A"}\`
- **앱 버전:** ${issue.appVersion || "N/A"}

### 수정 내용
${fixSummaries}

### 상세 설명
${fixData.prDescription || "Claude AI가 분석한 크래시 원인을 기반으로 수정 코드를 생성했습니다."}

---

> ⚠️ **이 PR은 AI가 자동 생성한 것입니다.** 반드시 코드 리뷰 후 머지해주세요.
> 🤖 Generated by crashlytics-slack-bot`,
        head: branchName,
        base: branch,
      });

      try {
        await this.octokit.rest.issues.addLabels({
          owner, repo, issue_number: pr.number,
          labels: ["bug", "crashlytics", "ai-fix"],
        });
      } catch {
        this.logger.warn("PR 라벨 추가 실패");
      }

      this.logger.log(`PR 생성 완료: #${pr.number} ${pr.html_url}`);
      return pr;
    } catch (error) {
      // 실패 시 브랜치 정리
      try {
        await this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
      } catch {
        // 무시
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
