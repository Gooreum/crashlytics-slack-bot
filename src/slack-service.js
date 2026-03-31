"use strict";

const { WebClient } = require("@slack/web-api");

const SLACK_BLOCK_LIMIT = 2900;

class SlackService {
  constructor(config, logger) {
    this.client = new WebClient(config.slack.botToken);
    this.channelId = config.slack.channelId;
    this.github = config.github;
    this.firebase = config.firebase;
    this.logger = logger;
  }

  /**
   * 크래시 초기 알림을 Slack에 전송하고 쓰레드 ts를 반환합니다.
   * @param {Object} event - Crashlytics 이벤트
   * @param {string} typeLabel
   * @param {string} emoji
   * @returns {Promise<string|null>} thread_ts
   */
  async postInitialAlert(event, typeLabel, emoji) {
    const payload = event.data?.payload || event.payload || event.data;
    const issue = payload?.issue;

    if (!issue) {
      this.logger.error(`${typeLabel} 이슈 데이터 없음`);
      return null;
    }

    const fullAppId = event.appId || "";
    const platform = fullAppId.includes("ios") ? "🍎 iOS" : "Unknown";

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${typeLabel}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*플랫폼:*\n${platform}` },
          { type: "mrkdwn", text: `*앱 버전:*\n${issue.appVersion || "N/A"}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*에러명:*\n\`${issue.title}\`\n*상세:*\n\`${issue.subtitle}\``,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "🤖 AI 분석 중... 잠시 후 쓰레드에 결과가 달립니다." },
        ],
      },
    ];

    // Firebase 콘솔 링크 (projectId가 있을 때만)
    if (this.firebase.projectId) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Firebase 콘솔에서 보기" },
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
      this.logger.error("Slack 초기 알림 전송 실패:", error.message);
      return null;
    }
  }

  /**
   * AI 분석 결과를 쓰레드 답글로 전송합니다.
   * @param {string} threadTs
   * @param {string|null} analysis
   * @param {{title, subtitle, appVersion}} issue
   * @param {Array} sourceResults
   */
  async postAnalysisThread(threadTs, analysis, issue, sourceResults) {
    const analysisText = analysis || "분석을 수행할 수 없었습니다. 데이터가 부족합니다.";

    // 긴 분석은 여러 블록으로 분할 (Slack 3000자 제한)
    const analysisChunks = [];
    for (let i = 0; i < analysisText.length; i += SLACK_BLOCK_LIMIT) {
      analysisChunks.push(analysisText.slice(i, i + SLACK_BLOCK_LIMIT));
    }

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "🤖 AI 크래시 분석 결과", emoji: true },
      },
      { type: "divider" },
    ];

    for (const chunk of analysisChunks) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }

    // 소스 코드 링크
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
          { type: "section", text: { type: "mrkdwn", text: `📂 *관련 소스 코드:*\n${fileLinks}` } }
        );
      }
    }

    // 버튼용 데이터 (Slack value 2000자 제한)
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
        text: { type: "plain_text", text: "🐛 GitHub Issue 생성" },
        action_id: "create_github_issue",
        value: buttonValue,
      },
    ];

    const hasFixableFiles = sourceResults?.some((r) => !r.error && r.filePath);
    if (hasFixableFiles) {
      actionElements.push({
        type: "button",
        text: { type: "plain_text", text: "🔀 수정 PR 생성" },
        style: "primary",
        action_id: "create_fix_pr",
        value: buttonValue,
        confirm: {
          title: { type: "plain_text", text: "수정 PR을 생성할까요?" },
          text: {
            type: "mrkdwn",
            text: "Claude AI가 크래시 원인을 분석하고 수정 코드를 생성하여 PR을 만듭니다.\n\n⚠️ *반드시 코드 리뷰 후 머지해주세요.*",
          },
          confirm: { type: "plain_text", text: "PR 생성" },
          deny: { type: "plain_text", text: "취소" },
        },
      });
    }

    blocks.push({ type: "divider" }, { type: "actions", elements: actionElements });

    try {
      await this.client.chat.postMessage({
        channel: this.channelId,
        thread_ts: threadTs,
        text: "AI 크래시 분석 결과",
        blocks,
      });
      await this.client.reactions.add({
        channel: this.channelId,
        name: "white_check_mark",
        timestamp: threadTs,
      });
    } catch (error) {
      this.logger.error("분석 쓰레드 전송 실패:", error.message);
    }
  }

  /**
   * 쓰레드에 일반 텍스트 메시지를 전송합니다.
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
   * 기존 메시지를 업데이트합니다.
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
