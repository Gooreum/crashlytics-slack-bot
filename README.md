# crashlytics-slack-bot

Firebase Crashlytics 크래시를 Slack으로 받고, Claude AI가 자동으로 분석하여 GitHub PR을 생성하는 npm 패키지입니다.

## 파이프라인

```
Crashlytics 크래시 감지
    ↓
Slack 초기 알림 (즉시)
    ↓
GitHub에서 크래시 관련 소스 코드 조회
    ↓
Claude AI 심층 분석 (근본 원인, 수정 코드, 위험 영역)
    ↓
Slack 쓰레드에 분석 결과 + 버튼 전송
    ↓
[버튼 클릭 시] GitHub Issue 생성 또는 수정 PR 자동 생성
```

## 설치

```bash
npm install crashlytics-slack-bot
```

## 사전 준비

### 1. Slack Bot Token
- Slack 앱 생성 → OAuth & Permissions
- Bot Token Scopes: `chat:write`, `reactions:write`
- 봇을 알림 채널에 초대

### 2. Slack Interactivity 설정
- Slack 앱 → Interactivity & Shortcuts → Request URL에 `slackInteraction` 함수 URL 입력

### 3. GitHub Token
- Settings → Developer settings → Personal access tokens
- 권한: `Contents (R/W)`, `Pull requests (R/W)`, `Issues (R/W)`, `Metadata (Read)`

### 4. Anthropic API Key
- https://console.anthropic.com 에서 발급

## 사용법 (Firebase Cloud Functions)

### functions/index.js

```js
const { setGlobalOptions } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const {
  onNewFatalIssuePublished,
  onNewNonfatalIssuePublished,
  onRegressionAlertPublished,
  onVelocityAlertPublished,
} = require("firebase-functions/v2/alerts/crashlytics");
const { createCrashlyticsBot } = require("crashlytics-slack-bot");

setGlobalOptions({ maxInstances: 10, region: "asia-northeast3" });

const SLACK_BOT_TOKEN = defineSecret("SLACK_BOT_TOKEN");
const ANTHROPIC_KEY   = defineSecret("ANTHROPIC_API_KEY");
const GITHUB_TOKEN    = defineSecret("GITHUB_TOKEN");

const SECRETS = {
  secrets: [SLACK_BOT_TOKEN, ANTHROPIC_KEY, GITHUB_TOKEN],
  timeoutSeconds: 300,
  memory: "512MiB",
};

// Bot 인스턴스 생성 헬퍼
function getBot() {
  return createCrashlyticsBot({
    github: {
      owner: "your-org",       // GitHub 조직/유저명
      repo: "your-ios-app",    // iOS 앱 레포지토리
      branch: "main",          // 기본 브랜치
      token: GITHUB_TOKEN.value(),
    },
    slack: {
      botToken: SLACK_BOT_TOKEN.value(),
      channelId: "C0XXXXXXX",  // Slack 채널 ID
    },
    claude: {
      apiKey: ANTHROPIC_KEY.value(),
    },
    firebase: {
      projectId: "your-firebase-project",
    },
  });
}

// Crashlytics 트리거
exports.postFatalToSlack = onNewFatalIssuePublished(SECRETS, async (event) => {
  await getBot().analyzeCrash(event, "초기 치명적 문제 발생", "🔥");
});

exports.postNonFatalToSlack = onNewNonfatalIssuePublished(SECRETS, async (event) => {
  await getBot().analyzeCrash(event, "신규 비치명적 문제 발생", "✨");
});

exports.postRegressionToSlack = onRegressionAlertPublished(SECRETS, async (event) => {
  await getBot().analyzeCrash(event, "회귀됨 (다시 발생한 이슈)", "↩️");
});

exports.postVelocityToSlack = onVelocityAlertPublished(SECRETS, async (event) => {
  await getBot().analyzeCrash(event, "반복되는 문제 (폭주 알림)", "📈");
});

// Slack 버튼 인터랙션
exports.slackInteraction = onRequest(
  { secrets: [SLACK_BOT_TOKEN, ANTHROPIC_KEY, GITHUB_TOKEN], cors: true, timeoutSeconds: 300 },
  async (req, res) => {
    await getBot().handleSlackInteraction(req, res);
  }
);
```

### Firebase Secrets 등록

```bash
firebase functions:secrets:set SLACK_BOT_TOKEN
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set GITHUB_TOKEN
```

### 배포

```bash
firebase deploy --only functions
```

## Config 옵션

| 키 | 필수 | 설명 |
|---|---|---|
| `github.owner` | ✅ | GitHub 조직/유저명 |
| `github.repo` | ✅ | iOS 앱 레포지토리 이름 |
| `github.branch` | - | 기본 브랜치 (기본값: `"main"`) |
| `github.token` | ✅ | GitHub Personal Access Token |
| `slack.botToken` | ✅ | Slack Bot OAuth Token |
| `slack.channelId` | ✅ | Slack 채널 ID |
| `claude.apiKey` | ✅ | Anthropic API Key |
| `firebase.projectId` | - | Firebase 프로젝트 ID (콘솔 링크 생성용) |
| `logger` | - | 커스텀 로거 (기본값: `console`) |

## 커스텀 로거 예시

```js
const bot = createCrashlyticsBot({
  // ...
  logger: {
    log: (...args) => myLogger.info(...args),
    warn: (...args) => myLogger.warn(...args),
    error: (...args) => myLogger.error(...args),
  },
});
```

## 라이선스

MIT
