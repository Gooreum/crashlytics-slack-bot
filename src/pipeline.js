"use strict";

const { extractFileInfoFromIssue } = require("./crash-parser");

/**
 * 크래시 분석 파이프라인을 생성합니다.
 * Crashlytics 이벤트 → Slack 알림 → GitHub 소스 조회 → Claude 분석 → Slack 쓰레드
 */
class Pipeline {
  constructor({ slackService, githubService, claudeService }, logger) {
    this.slack = slackService;
    this.github = githubService;
    this.claude = claudeService;
    this.logger = logger;
  }

  /**
   * 크래시 분석 파이프라인을 실행합니다.
   * @param {Object} event - Crashlytics 이벤트 또는 이와 호환되는 객체
   * @param {string} typeLabel - 알림 유형 레이블 (예: "초기 치명적 문제 발생")
   * @param {string} emoji - 이모지 (예: "🔥")
   */
  async run(event, typeLabel, emoji) {
    const payload = event.data?.payload || event.payload || event.data;
    const issue = payload?.issue;

    if (!issue) {
      this.logger.error("이슈 데이터 없음, 파이프라인 종료");
      return;
    }

    // Step 1: Slack 초기 알림 (즉시)
    const threadTs = await this.slack.postInitialAlert(event, typeLabel, emoji);
    if (!threadTs) return;

    try {
      // Step 2: 이슈에서 파일/라인 정보 추출
      const fileInfo = extractFileInfoFromIssue(issue);
      this.logger.log("추출된 파일 정보:", fileInfo);

      // Step 3: GitHub 소스 코드 조회
      let sourceResults = [];
      if (fileInfo.length > 0) {
        sourceResults = await this.github.fetchSource(fileInfo);
        this.logger.log("소스 코드 조회:", sourceResults.map((r) => ({ file: r.file, found: !r.error })));
      }

      // Step 4: Claude AI 분석 (실패 시 1회 재시도)
      let analysis = await this.claude.analyze(issue, typeLabel, sourceResults);
      if (!analysis) {
        this.logger.warn("⚠️ Claude 분석 실패, 5초 후 재시도...");
        await new Promise((r) => setTimeout(r, 5000));
        analysis = await this.claude.analyze(issue, typeLabel, sourceResults);
      }

      // Step 5: 분석 결과를 쓰레드로 전송
      await this.slack.postAnalysisThread(threadTs, analysis, issue, sourceResults);
    } catch (error) {
      this.logger.error("파이프라인 실패:", error.message);
      try {
        await this.slack.postMessage(null, threadTs, `❌ AI 분석 중 오류가 발생했습니다: ${error.message}\n\n수동으로 확인해주세요.`);
      } catch {
        this.logger.error("에러 메시지 전송도 실패");
      }
    }
  }
}

module.exports = { Pipeline };
