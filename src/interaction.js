"use strict";

const { verifySlackSignature } = require("./slack-signature");
const { t, prProgress } = require("./i18n");

/**
 * Handles Slack button interactions:
 * - create_github_issue
 * - create_fix_pr
 *
 * ⚠️ Firebase Cloud Functions Gen 2: CPU may be throttled after res.send(),
 * so all work is finished before responding.
 */
class InteractionHandler {
  constructor({ slackService, githubService, claudeService }, logger, { signingSecret, language }) {
    this.slack = slackService;
    this.github = githubService;
    this.claude = claudeService;
    this.logger = logger;
    this.signingSecret = signingSecret;
    this.msg = t(language);
  }

  /**
   * Handles a Slack interaction request. Usable as an Express / Cloud Functions (req, res) handler.
   */
  async handle(req, res) {
    this.logger.log("🔔 slackInteraction called", {
      method: req.method,
      contentType: req.headers["content-type"],
    });

    // Verify the request came from Slack (Firebase Functions provides req.rawBody)
    const verified = verifySlackSignature({
      signingSecret: this.signingSecret,
      rawBody: req.rawBody,
      timestamp: req.headers["x-slack-request-timestamp"],
      signature: req.headers["x-slack-signature"],
    });
    if (!verified) {
      this.logger.warn("Rejected Slack request: invalid signature");
      res.status(401).send("invalid signature");
      return;
    }

    let payload;
    try {
      const rawPayload = req.body?.payload || req.body;
      payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    } catch (err) {
      this.logger.error("Failed to parse payload:", err.message);
      res.status(200).send("ok");
      return;
    }

    if (!payload || payload.type !== "block_actions") {
      res.status(200).send("ok");
      return;
    }

    const action = payload.actions[0];
    const channelId = payload.channel?.id;
    const threadTs = payload.message?.thread_ts || payload.message?.ts;

    this.logger.log("🎯 Action:", action.action_id, "channel:", channelId);

    try {
      if (action.action_id === "create_github_issue") {
        await this._handleCreateIssue(action, channelId, threadTs);
      } else if (action.action_id === "create_fix_pr") {
        await this._handleCreatePR(action, channelId, threadTs);
      }
    } catch (error) {
      this.logger.error("Interaction failed:", error.message);
    }

    // ★ Respond only after all work is done (Firebase Gen 2)
    res.status(200).send("ok");
  }

  async _handleCreateIssue(action, channelId, threadTs) {
    const crashInfo = JSON.parse(action.value);
    this.logger.log("📝 Creating GitHub issue");

    const issue = await this.github.createIssue(crashInfo);
    this.logger.log("✅ GitHub issue created:", issue.html_url);

    await this.slack.postMessage(
      channelId,
      threadTs,
      this.msg.issueCreated(issue.html_url, issue.number, issue.title)
    );
  }

  async _handleCreatePR(action, channelId, threadTs) {
    const crashInfo = JSON.parse(action.value);
    this.logger.log("🔀 Creating fix PR, files:", crashInfo.files);

    // Progress message
    const statusMsg = await this.slack.postMessage(channelId, threadTs, prProgress(this.msg, 0));

    try {
      // 1. Re-fetch source code
      const sourceResults = await this.github.fetchSource(crashInfo.files);
      await this.slack.updateMessage(channelId, statusMsg.ts, prProgress(this.msg, 1));

      // 2. Generate the fix with Claude
      const fixData = await this.claude.generateFix(crashInfo, sourceResults);
      if (!fixData) {
        await this.slack.updateMessage(channelId, statusMsg.ts, this.msg.prNoFix);
        return;
      }

      await this.slack.updateMessage(channelId, statusMsg.ts, prProgress(this.msg, 2));

      // 3. Open the PR on GitHub
      const pr = await this.github.createFixPR(crashInfo, fixData, sourceResults);
      this.logger.log("✅ PR created:", pr.html_url);

      const fixSummaries = fixData.fixes
        .map((f) => `• \`${f.filePath}\` — ${f.summary}`)
        .join("\n");

      await this.slack.updateMessage(
        channelId,
        statusMsg.ts,
        this.msg.prCreatedText(pr.number),
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${this.msg.prCreatedTitle}\n\n<${pr.html_url}|#${pr.number} ${pr.title}>`,
            },
          },
          { type: "divider" },
          {
            type: "section",
            text: { type: "mrkdwn", text: `${this.msg.prChangesHeader}\n${fixSummaries}` },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: this.msg.aiReviewWarning }],
          },
        ]
      );
    } catch (error) {
      this.logger.error("Fix PR pipeline failed:", error.message);
      try {
        await this.slack.updateMessage(channelId, statusMsg.ts, this.msg.prFailed(error.message));
      } catch (e) {
        this.logger.error("Failed to post the error message as well:", e.message);
      }
    }
  }
}

module.exports = { InteractionHandler };
