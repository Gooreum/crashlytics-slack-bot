"use strict";

const { WebClient } = require("@slack/web-api");
const { t } = require("./i18n");
const { detectPlatform } = require("./crash-parser");

// Slack section blocks are limited to 3000 characters.
const SLACK_BLOCK_LIMIT = 2900;

class SlackService {
  constructor(config, logger, client = new WebClient(config.slack.botToken)) {
    this.client = client;
    this.channelId = config.slack.channelId;
    this.github = config.github;
    this.firebase = config.firebase;
    this.platform = config.platform;
    this.msg = t(config.language);
    this.logger = logger;
  }

  /**
   * Posts the initial crash alert and returns its ts (used as the thread root).
   * @param {Object} event - Crashlytics event
   * @param {string} typeLabel
   * @param {string} emoji
   * @returns {Promise<string|null>} thread_ts
   */
  async postInitialAlert(event, typeLabel, emoji) {
    const payload = event.data?.payload || event.payload || event.data;
    const issue = payload?.issue;

    if (!issue) {
      this.logger.error(`${typeLabel}: event has no issue data`);
      return null;
    }

    const platform = this.msg.platformNames[detectPlatform(event.appId, this.platform)];

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${typeLabel}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*${this.msg.platformLabel}:*\n${platform}` },
          { type: "mrkdwn", text: `*${this.msg.appVersionLabel}:*\n${issue.appVersion || "N/A"}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${this.msg.errorLabel}:*\n\`${issue.title}\`\n*${this.msg.detailsLabel}:*\n\`${issue.subtitle}\``,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: this.msg.analyzing }],
      },
    ];

    // Firebase console link (only when projectId is known)
    if (this.firebase.projectId) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: this.msg.openInConsole },
            style: "danger",
            url: `https://console.firebase.google.com/project/${this.firebase.projectId}/crashlytics`,
          },
        ],
      });
    }

    try {
      const result = await this.client.chat.postMessage({
        channel: this.channelId,
        text: `${emoji} ${typeLabel}: ${issue.title}`,
        blocks,
      });
      return result.ts;
    } catch (error) {
      this.logger.error("Failed to post initial Slack alert:", error.message);
      return null;
    }
  }

  /**
   * Posts the AI analysis as a thread reply, with Issue/PR buttons.
   * @param {string} threadTs
   * @param {string|null} analysis
   * @param {{title, subtitle, appVersion}} issue
   * @param {Array} sourceResults
   */
  async postAnalysisThread(threadTs, analysis, issue, sourceResults) {
    const analysisText = analysis || this.msg.analysisUnavailable;

    // Split long analyses across multiple blocks
    const analysisChunks = [];
    for (let i = 0; i < analysisText.length; i += SLACK_BLOCK_LIMIT) {
      analysisChunks.push(analysisText.slice(i, i + SLACK_BLOCK_LIMIT));
    }

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: this.msg.analysisHeader, emoji: true },
      },
      { type: "divider" },
    ];

    for (const chunk of analysisChunks) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }

    // Source code links
    if (sourceResults && sourceResults.length > 0) {
      const { owner, repo, branch } = this.github;
      const fileLinks = sourceResults
        .filter((r) => !r.error && r.filePath)
        .map((r) =>
          `<https://github.com/${owner}/${repo}/blob/${branch}/${r.filePath}#L${r.line || 1}|${r.filePath}:${r.line || ""}>`
        )
        .join("\n");

      if (fileLinks) {
        blocks.push(
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: `${this.msg.relatedSource}\n${fileLinks}` } }
        );
      }
    }

    // Button payload (Slack limits button values to 2000 characters)
    const buttonData = {
      title: issue.title || "Unknown crash",
      subtitle: issue.subtitle || "",
      appVersion: issue.appVersion || "",
      files: (sourceResults || [])
        .filter((r) => !r.error && r.filePath)
        .map((r) => ({ filePath: r.filePath, line: r.line })),
    };
    const buttonValue = JSON.stringify(buttonData);

    const actionElements = [
      {
        type: "button",
        text: { type: "plain_text", text: this.msg.createIssueButton },
        action_id: "create_github_issue",
        value: buttonValue,
      },
    ];

    const hasFixableFiles = sourceResults?.some((r) => !r.error && r.filePath);
    if (hasFixableFiles) {
      actionElements.push({
        type: "button",
        text: { type: "plain_text", text: this.msg.createPrButton },
        style: "primary",
        action_id: "create_fix_pr",
        value: buttonValue,
        confirm: {
          title: { type: "plain_text", text: this.msg.confirmPrTitle },
          text: { type: "mrkdwn", text: this.msg.confirmPrText },
          confirm: { type: "plain_text", text: this.msg.confirmPrOk },
          deny: { type: "plain_text", text: this.msg.confirmPrCancel },
        },
      });
    }

    blocks.push({ type: "divider" }, { type: "actions", elements: actionElements });

    try {
      await this.client.chat.postMessage({
        channel: this.channelId,
        thread_ts: threadTs,
        text: this.msg.analysisFallbackText,
        blocks,
      });
      await this.client.reactions.add({
        channel: this.channelId,
        name: "white_check_mark",
        timestamp: threadTs,
      });
    } catch (error) {
      this.logger.error("Failed to post analysis thread:", error.message);
    }
  }

  /**
   * Posts a plain message in a thread.
   */
  async postMessage(channelId, threadTs, text, blocks) {
    return this.client.chat.postMessage({
      channel: channelId || this.channelId,
      thread_ts: threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
  }

  /**
   * Updates an existing message.
   */
  async updateMessage(channelId, ts, text, blocks) {
    return this.client.chat.update({
      channel: channelId || this.channelId,
      ts,
      text,
      ...(blocks ? { blocks } : {}),
    });
  }
}

module.exports = { SlackService };
