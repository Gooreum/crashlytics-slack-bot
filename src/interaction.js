"use strict";

const { verifySlackSignature } = require("./slack-signature");

/**
 * Slack 버튼 인터랙션 핸들러를 생성합니다.
 * - GitHub Issue 생성 (create_github_issue)
 * - 수정 PR 생성 (create_fix_pr)
 *
 * ⚠️ Firebase Cloud Functions Gen 2 주의사항:
 * res.send() 이후 CPU가 스로틀링될 수 있으므로
 * 모든 작업을 완료한 후 res.send()를 호출해야 합니다.
 */
class InteractionHandler {
  constructor({ slackService, githubService, claudeService }, logger, { signingSecret }) {
    this.slack = slackService;
    this.github = githubService;
    this.claude = claudeService;
    this.logger = logger;
    this.signingSecret = signingSecret;
  }

  /**
   * Slack 인터랙션 요청을 처리합니다.
   * Express/Cloud Functions의 (req, res) 핸들러로 사용합니다.
   */
  async handle(req, res) {
    this.logger.log("🔔 slackInteraction 호출됨", {
      method: req.method,
      contentType: req.headers["content-type"],
    });

    // Slack이 보낸 요청인지 검증 (Firebase Functions는 req.rawBody를 제공)
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
      this.logger.error("payload 파싱 실패:", err.message);
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

    this.logger.log("🎯 액션:", action.action_id, "채널:", channelId);

    try {
      if (action.action_id === "create_github_issue") {
        await this._handleCreateIssue(action, channelId, threadTs);
      } else if (action.action_id === "create_fix_pr") {
        await this._handleCreatePR(action, channelId, threadTs);
      }
    } catch (error) {
      this.logger.error("인터랙션 처리 실패:", error.message);
    }

    // ★ 모든 작업 완료 후 응답 (Firebase Gen 2 호환)
    res.status(200).send("ok");
  }

  async _handleCreateIssue(action, channelId, threadTs) {
    const crashInfo = JSON.parse(action.value);
    this.logger.log("📝 GitHub Issue 생성 시작");

    const issue = await this.github.createIssue(crashInfo);
    this.logger.log("✅ GitHub Issue 생성 완료:", issue.html_url);

    await this.slack.postMessage(
      channelId,
      threadTs,
      `✅ GitHub Issue 생성 완료: <${issue.html_url}|#${issue.number} ${issue.title}>`
    );
  }

  async _handleCreatePR(action, channelId, threadTs) {
    const crashInfo = JSON.parse(action.value);
    this.logger.log("🔀 PR 생성 시작, files:", crashInfo.files);

    // 진행 상태 메시지
    const statusMsg = await this.slack.postMessage(
      channelId,
      threadTs,
      "🔄 수정 PR을 생성하고 있습니다...\n\n① 소스 코드 조회 중..."
    );

    try {
      // Step 1: 소스 코드 재조회
      const sourceResults = await this.github.fetchSource(crashInfo.files);
      await this.slack.updateMessage(
        channelId,
        statusMsg.ts,
        "🔄 수정 PR을 생성하고 있습니다...\n\n① 소스 코드 조회 ✅\n② Claude AI가 수정 코드 생성 중..."
      );

      // Step 2: Claude 수정 코드 생성
      const fixData = await this.claude.generateFix(crashInfo, sourceResults);
      if (!fixData) {
        await this.slack.updateMessage(
          channelId,
          statusMsg.ts,
          "❌ 수정 코드를 생성할 수 없었습니다. 소스 코드가 부족하거나 Claude API 오류가 발생했습니다."
        );
        return;
      }

      await this.slack.updateMessage(
        channelId,
        statusMsg.ts,
        "🔄 수정 PR을 생성하고 있습니다...\n\n① 소스 코드 조회 ✅\n② 수정 코드 생성 ✅\n③ GitHub에 브랜치 생성 및 커밋 중..."
      );

      // Step 3: GitHub PR 생성
      const pr = await this.github.createFixPR(crashInfo, fixData, sourceResults);
      this.logger.log("✅ PR 생성 완료:", pr.html_url);

      const fixSummaries = fixData.fixes
        .map((f) => `• \`${f.filePath}\` — ${f.summary}`)
        .join("\n");

      await this.slack.updateMessage(
        channelId,
        statusMsg.ts,
        `✅ 수정 PR 생성 완료: #${pr.number}`,
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *수정 PR 생성 완료!*\n\n<${pr.html_url}|#${pr.number} ${pr.title}>`,
            },
          },
          { type: "divider" },
          {
            type: "section",
            text: { type: "mrkdwn", text: `📝 *수정 내용:*\n${fixSummaries}` },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "⚠️ AI가 자동 생성한 코드입니다. 반드시 코드 리뷰 후 머지해주세요.",
              },
            ],
          },
        ]
      );
    } catch (error) {
      this.logger.error("PR 생성 파이프라인 실패:", error.message);
      try {
        await this.slack.updateMessage(
          channelId,
          statusMsg.ts,
          `❌ PR 생성 실패: ${error.message}`
        );
      } catch (e) {
        this.logger.error("에러 메시지 전송도 실패:", e.message);
      }
    }
  }
}

module.exports = { InteractionHandler };
