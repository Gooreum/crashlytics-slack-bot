"use strict";

const { extractFileInfoFromIssue } = require("./crash-parser");
const { t } = require("./i18n");

/**
 * Crash analysis pipeline:
 * Crashlytics event → Slack alert → GitHub source lookup → Claude analysis → Slack thread
 */
class Pipeline {
  constructor({ slackService, githubService, claudeService }, logger, { language } = {}) {
    this.slack = slackService;
    this.github = githubService;
    this.claude = claudeService;
    this.msg = t(language);
    this.logger = logger;
  }

  /**
   * Runs the pipeline.
   * @param {Object} event - Crashlytics event (or a compatible object)
   * @param {string} typeLabel - alert label, e.g. "New fatal issue"
   * @param {string} emoji - e.g. "🔥"
   */
  async run(event, typeLabel, emoji) {
    const payload = event.data?.payload || event.payload || event.data;
    const issue = payload?.issue;

    if (!issue) {
      this.logger.error("Event has no issue data; stopping pipeline");
      return;
    }

    // 1. Initial Slack alert (immediately)
    const threadTs = await this.slack.postInitialAlert(event, typeLabel, emoji);
    if (!threadTs) return;

    try {
      // 2. Extract file/line info from the issue
      const fileInfo = extractFileInfoFromIssue(issue);
      this.logger.log("Extracted file info:", fileInfo);

      // 3. Fetch source code from GitHub
      let sourceResults = [];
      if (fileInfo.length > 0) {
        sourceResults = await this.github.fetchSource(fileInfo);
        this.logger.log("Source lookup:", sourceResults.map((r) => ({ file: r.file, found: !r.error })));
      }

      // 4. Claude analysis (one retry on failure)
      let analysis = await this.claude.analyze(issue, typeLabel, sourceResults);
      if (!analysis) {
        this.logger.warn("⚠️ Claude analysis failed, retrying in 5s…");
        await new Promise((r) => setTimeout(r, 5000));
        analysis = await this.claude.analyze(issue, typeLabel, sourceResults);
      }

      // 5. Post the analysis in the thread
      await this.slack.postAnalysisThread(threadTs, analysis, issue, sourceResults);
    } catch (error) {
      this.logger.error("Pipeline failed:", error.message);
      try {
        await this.slack.postMessage(null, threadTs, this.msg.pipelineError(error.message));
      } catch {
        this.logger.error("Failed to post the error message as well");
      }
    }
  }
}

module.exports = { Pipeline };
