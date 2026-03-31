"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { getPatternHint } = require("./crash-parser");

class ClaudeService {
  constructor(config, logger) {
    this.client = new Anthropic({ apiKey: config.claude.apiKey });
    this.logger = logger;
  }

  /**
   * 크래시 정보와 소스 코드를 바탕으로 AI 심층 분석을 수행합니다.
   * @param {{title, subtitle, appVersion}} issue
   * @param {string} typeLabel
   * @param {Array} sourceResults
   * @returns {Promise<string|null>}
   */
  async analyze(issue, typeLabel, sourceResults) {
    try {
      const patternHint = getPatternHint(issue.title);

      let sourceContext = "소스 코드 조회를 수행하지 않았거나 실패했습니다.";
      if (sourceResults && sourceResults.length > 0) {
        sourceContext = sourceResults.map((r) => {
          if (r.error) return `### ${r.file} (라인 ${r.line || "N/A"})\n조회 실패: ${r.error}`;
          return `### ${r.filePath} (크래시 라인: ${r.line || "N/A"})
\`\`\`swift
${r.content}
\`\`\`

**최근 변경 이력:**
${r.recentCommits}`;
        }).join("\n\n");
      }

      const prompt = `당신은 iOS/Swift 크래시 분석 전문가입니다. Firebase Crashlytics에서 감지된 크래시를 분석해주세요.

## 크래시 정보
- 알림 유형: ${typeLabel}
- 에러 제목: ${issue.title || "N/A"}
- 상세 정보 (메서드/위치): ${issue.subtitle || "N/A"}
- 앱 버전: ${issue.appVersion || "N/A"}

## iOS 크래시 패턴 분석
${patternHint}

## 관련 소스 코드 (GitHub에서 조회)
${sourceContext}

---

다음 항목을 분석해주세요:

1. **🔍 근본 원인 (Root Cause)**
   에러명, 메서드, 소스 코드를 종합하여 크래시의 정확한 원인을 설명하세요.

2. **🔄 재현 시나리오**
   어떤 사용자 흐름에서 이 크래시가 발생할 수 있는지 1-2개 시나리오를 제시하세요.

3. **🛠️ 수정 코드**
   구체적인 Swift 코드 패치를 제안하세요. guard let, Optional 체이닝, nil 병합 등 적절한 방어 코드를 포함하세요.

4. **🛡️ 방어 코드 추가 제안**
   같은 패턴의 크래시를 예방할 수 있는 추가 방어 로직이 있다면 제안하세요.

5. **⚠️ 추가 위험 영역**
   같은 파일이나 프로젝트에서 비슷한 패턴의 위험이 있을 수 있는 곳을 지적하세요.

Slack 메시지에 표시될 내용이므로, Markdown 포맷으로 간결하게 작성해주세요. 각 항목은 3-5문장 이내.`;

      const response = await this.client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });

      return response.content[0].text;
    } catch (error) {
      this.logger.error("Claude 분석 실패:", error.message);
      return null;
    }
  }

  /**
   * 크래시 수정 코드를 생성합니다 (PR용 JSON 응답).
   * @param {{title, subtitle}} issue
   * @param {Array} sourceResults
   * @returns {Promise<{fixes, prTitle, prDescription}|null>}
   */
  async generateFix(issue, sourceResults) {
    const fixableFiles = sourceResults.filter((r) => !r.error && r.fullContent);
    if (fixableFiles.length === 0) {
      this.logger.warn("수정 가능한 소스 파일이 없어 PR 생성을 건너뜁니다.");
      return null;
    }

    try {
      const filesContext = fixableFiles.map((r) =>
        `### 파일: ${r.filePath} (크래시 라인: ${r.line || "N/A"})
\`\`\`swift
${r.fullContent}
\`\`\``
      ).join("\n\n");

      const prompt = `당신은 iOS/Swift 크래시를 수정하는 시니어 개발자입니다.

## 크래시 정보
- 에러: ${issue.title || "N/A"}
- 상세: ${issue.subtitle || "N/A"}

## 수정 대상 소스 코드 (전체 파일)
${filesContext}

---

위 크래시를 수정해주세요.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

\`\`\`json
{
  "fixes": [
    {
      "filePath": "수정할 파일의 정확한 경로",
      "fixedCode": "수정된 전체 파일 코드",
      "summary": "변경 내용 한줄 요약"
    }
  ],
  "prTitle": "간결한 PR 제목",
  "prDescription": "수정 내용 상세 설명 (Markdown)"
}
\`\`\`

중요 규칙:
- fixedCode는 해당 파일의 수정 완료된 **전체 코드**여야 합니다.
- 기존 코드 구조와 스타일을 최대한 유지하면서 크래시 원인만 수정하세요.
- guard let, Optional 체이닝, nil 병합 연산자 등 Swift 안전 패턴을 사용하세요.
- 불필요한 변경은 하지 마세요. 크래시 수정에 필요한 최소한의 변경만 하세요.
- JSON만 응답하고, \`\`\`json 마크다운 펜스로 감싸세요.`;

      const response = await this.client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 16384,
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "max_tokens") {
        this.logger.warn("⚠️ Claude 응답이 max_tokens로 잘림");
      }

      const text = response.content[0].text;
      return this._parseFixResponse(text);
    } catch (error) {
      this.logger.error("Claude 수정 코드 생성 실패:", error.message);
      return null;
    }
  }

  _parseFixResponse(text) {
    let jsonStr;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      jsonStr = text;
    }

    // 정상 파싱 시도
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (!parsed.fixes || !Array.isArray(parsed.fixes) || parsed.fixes.length === 0) {
        this.logger.error("Claude 응답에 fixes가 없습니다.");
        return null;
      }
      return parsed;
    } catch {
      this.logger.warn("⚠️ JSON 파싱 실패, 복구 시도");
    }

    // 잘린 JSON 복구
    let repaired = jsonStr.trim();
    const openQuotes = (repaired.match(/"/g) || []).length;
    if (openQuotes % 2 !== 0) repaired += '"';
    const openBraces = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/]/g) || []).length;
    for (let i = 0; i < openBrackets; i++) repaired += "]";
    for (let i = 0; i < openBraces; i++) repaired += "}";

    try {
      const parsed = JSON.parse(repaired);
      if (!parsed.fixes || !Array.isArray(parsed.fixes) || parsed.fixes.length === 0) {
        this.logger.error("복구된 JSON에 fixes가 없습니다.");
        return null;
      }
      this.logger.log("✅ JSON 복구 성공");
      return parsed;
    } catch {
      this.logger.error("❌ JSON 복구도 실패");
      return null;
    }
  }
}

module.exports = { ClaudeService };
