"use strict";

/**
 * Text for the `init` wizard. Every language must define exactly the same keys (enforced by tests).
 * Bot runtime text (Slack messages, GitHub issues/PRs) lives in src/i18n.js.
 */

// Asked before a language is chosen, so it's shown in both.
const LANGUAGE_PROMPT = "Language / 언어";

const WIZARD = {
  en: {
    intro: "crashlytics-slack-bot setup",
    required: "Required",

    checklistTitle: "Before you start",
    checklist: [
      "Firebase project on the Blaze (pay-as-you-go) plan\n  Firebase Console → ⚙️ Usage and billing → Details & settings → Modify plan",
      "Crashlytics set up in your app, with at least one crash or event visible\n  Firebase Console → Crashlytics",
      "Permission to install apps in your Slack workspace\n  (or a workspace admin who can approve the install)",
      "Access to your app's GitHub repository\n  (for organization repos, an owner may need to approve your token)",
      "An Anthropic account with credits\n  https://console.anthropic.com → Settings → Billing",
    ],
    checklistConfirm: "Do you have all of these ready?",
    checklistNotReady: "No problem — nothing was changed. Run `npx crashlytics-slack-bot init` again when you're ready.",

    firebaseMissing: "Firebase CLI not found. Install it with `npm install -g firebase-tools`, then run `firebase login`.",
    firebaseLogin: "You're not logged in to Firebase. Run `firebase login`, then try again.",
    noProjects: "No Firebase projects found for this account. Create one at https://console.firebase.google.com and add your app.",

    projectPrompt: "Firebase project",
    regionTitle: "Cloud Functions region",
    regionHelp: "Pick the region closest to your team. For example:\n  Seoul asia-northeast3 · Tokyo asia-northeast1 · Singapore asia-southeast1\n  Belgium europe-west1 · Iowa us-central1\nChanging it later means running init again and redeploying.",
    regionPrompt: "Region",
    platformPrompt: "App platform",
    platformOptions: {
      ios: "iOS (Swift / Objective-C)",
      android: "Android (Kotlin / Java)",
      auto: "Both — detect from each alert",
    },

    githubOwnerPrompt: "GitHub owner (user or organization)",
    githubRepoPrompt: "GitHub repository with the app's source code",
    githubBranchPrompt: "Base branch for fix PRs",
    githubTokenTitle: "Create a GitHub token",
    githubTokenSteps: (owner, repo) => [
      "1. Open https://github.com/settings/personal-access-tokens/new",
      `2. Resource owner: ${owner} (choose the organization if the repo belongs to one)`,
      "3. Expiration: pick a date and set a reminder — the bot stops working when the token expires",
      `4. Repository access → Only select repositories → ${repo}`,
      "5. Permissions → Repository permissions → Contents, Issues, Pull requests → Read and write",
      "6. Click Generate token and copy it (GitHub shows it only once)",
      "For organization repos, an owner may need to approve the token:",
      "  Organization settings → Personal access tokens → Pending requests",
    ].join("\n"),
    githubTokenPrompt: "GitHub token",

    anthropicTitle: "Create an Anthropic API key",
    anthropicSteps: [
      "1. Sign up or log in at https://console.anthropic.com",
      "2. Settings → Billing → add a payment method and buy credits",
      "   (without credits, every analysis fails)",
      "3. Settings → API Keys → Create Key → name it (e.g. crashlytics-slack-bot)",
      "4. Copy the key — it starts with sk-ant- and is shown only once",
      "Each crash alert makes one Claude request (two if the first attempt fails and is retried); each fix PR makes one more.",
    ].join("\n"),
    anthropicPrompt: "Anthropic API key",

    slackTitle: "Create the Slack app",
    slackSteps: (link, url) => [
      "1. Open this link to create the app from a pre-filled manifest:",
      `   ${link}`,
      "   Pick your workspace → Next → Create",
      "2. Left menu → Install App → Install to Workspace → Allow",
      "   If you see \"Request to Install\", a workspace admin must approve it first.",
      "3. Left menu → OAuth & Permissions → copy the Bot User OAuth Token (starts with xoxb-)",
      "4. Left menu → Basic Information → App Credentials → Signing Secret → click Show and copy it",
      `The interactivity URL is already in the manifest: ${url}`,
    ].join("\n"),
    slackBotTokenPrompt: "Slack Bot User OAuth Token (xoxb-…)",
    slackBotTokenFormat: "Bot tokens start with xoxb-. Copy it from OAuth & Permissions.",
    signingSecretPrompt: "Slack Signing Secret (Basic Information → App Credentials → Show)",

    channelTitle: "Find the Slack channel ID",
    channelSteps: [
      "1. In Slack, open the channel that should receive alerts",
      "2. Click the channel name at the top",
      "3. Scroll to the bottom of the About tab and copy the Channel ID (e.g. C0123456789)",
    ].join("\n"),
    channelPrompt: "Slack channel ID",
    channelFormat: "Channel IDs look like C0123456789.",
    inviteBot: "Type `/invite @Crashlytics Bot` in that channel. Private channels get no alerts until the bot is invited.",

    checking: {
      github: "Checking GitHub access…",
      anthropic: "Checking the Anthropic API key and credits…",
      slack: "Checking the Slack token…",
    },
    checkOk: "Looks good",
    checkFailed: "Check failed",

    notEmpty: (dir) => `${dir} is not empty. Overwrite the generated files?`,
    cancelledNothing: "Setup cancelled — nothing was changed.",
    created: (dir) => `Created ${dir}/`,
    storingSecrets: "Storing secrets in Secret Manager…",
    secretsStored: "Secrets stored",
    skipDeployOutro: (cmd) => `Files and secrets are ready. Deploy when you're ready:\n  ${cmd}`,
    deployFailed: (cmd) => `Deployment failed. Fix the error above, then run:\n  ${cmd}`,
    done: (dir) => `Done! New Crashlytics alerts will show up in Slack.\nSend a test alert now: npx crashlytics-slack-bot test --dir ${dir}`,
    cancelled: "Setup cancelled.",

    errors: {
      github: {
        401: [
          "GitHub says the token is invalid or expired.",
          "• Make sure you pasted the whole token (github_pat_… or ghp_…).",
          "• If it expired or was deleted, create a new one with the steps above.",
        ].join("\n"),
        403: [
          "GitHub refused access with this token.",
          "• Organization repo: the token may be waiting for an owner's approval",
          "  (Organization settings → Personal access tokens → Pending requests).",
          "• If the organization uses SAML SSO, authorize the token for SSO.",
          "• You may have hit GitHub's rate limit — wait a minute and try again.",
        ].join("\n"),
        404: (owner, repo) => [
          `Couldn't find ${owner}/${repo} with this token.`,
          "• Check the owner and repository names for typos.",
          `• Make sure the token's Repository access includes ${repo}`,
          "  (Settings → Developer settings → Personal access tokens → your token → Edit).",
          "• For an organization repo, the token's Resource owner must be the organization.",
        ].join("\n"),
        other: (status) => `GitHub returned HTTP ${status}. Check https://www.githubstatus.com and try again.`,
      },
      anthropic: {
        401: [
          "Anthropic says the API key is invalid.",
          "• Make sure you pasted the whole key (it starts with sk-ant-).",
          "• If it was deleted, create a new one under Settings → API Keys.",
        ].join("\n"),
        403: [
          "This API key isn't allowed to call the API.",
          "• Check the key's workspace permissions, or create a new key in the Default workspace.",
        ].join("\n"),
        credit: [
          "Your Anthropic credit balance is too low.",
          "• Add credits at https://console.anthropic.com → Settings → Billing, then try again.",
          "  It can take a minute for new credits to apply.",
        ].join("\n"),
        other: (status) => `Anthropic returned HTTP ${status}. Check https://status.anthropic.com and try again.`,
      },
      slack: {
        invalid_auth: [
          "Slack doesn't recognize this token.",
          "• Copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions —",
          "  not the Signing Secret, Client Secret, or an app-level token.",
        ].join("\n"),
        not_authed: "No token reached Slack. Paste the Bot User OAuth Token (xoxb-…) again.",
        token_revoked: "This token was revoked — the app was probably uninstalled.\n• Reinstall it (Install App → Reinstall to Workspace) and copy the new token.",
        token_expired: "This token expired.\n• Turn off token rotation under OAuth & Permissions → Advanced token security, then reinstall the app and copy the new token.",
        account_inactive: "The app or workspace is inactive.\n• Reinstall the app to your workspace and copy the new token.",
        other: (code) => `Slack returned "${code}". See https://api.slack.com/methods/auth.test for what it means.`,
      },
    },
  },

  ko: {
    intro: "crashlytics-slack-bot 설치",
    required: "필수 입력입니다",

    checklistTitle: "시작하기 전에 확인하세요",
    checklist: [
      "Firebase 프로젝트가 Blaze(종량제) 요금제인지\n  Firebase 콘솔 → ⚙️ 사용량 및 결제 → 세부정보 및 설정 → 요금제 변경",
      "앱에 Crashlytics가 설정되어 있고, 크래시나 이벤트가 하나 이상 보이는지\n  Firebase 콘솔 → Crashlytics",
      "Slack 워크스페이스에 앱을 설치할 권한이 있는지\n  (없다면 설치를 승인해 줄 워크스페이스 관리자)",
      "앱 GitHub 저장소에 접근할 수 있는지\n  (조직 저장소라면 조직 소유자가 토큰을 승인해야 할 수 있음)",
      "크레딧이 충전된 Anthropic 계정이 있는지\n  https://console.anthropic.com → Settings → Billing",
    ],
    checklistConfirm: "모두 준비됐나요?",
    checklistNotReady: "괜찮아요 — 아무것도 변경하지 않았습니다. 준비되면 `npx crashlytics-slack-bot init`을 다시 실행하세요.",

    firebaseMissing: "Firebase CLI가 없습니다. `npm install -g firebase-tools`로 설치한 뒤 `firebase login`을 실행하세요.",
    firebaseLogin: "Firebase에 로그인되어 있지 않습니다. `firebase login`을 실행한 뒤 다시 시도하세요.",
    noProjects: "이 계정에 Firebase 프로젝트가 없습니다. https://console.firebase.google.com 에서 프로젝트를 만들고 앱을 추가하세요.",

    projectPrompt: "Firebase 프로젝트",
    regionTitle: "Cloud Functions 리전",
    regionHelp: "팀과 가장 가까운 리전을 고르세요. 예:\n  서울 asia-northeast3 · 도쿄 asia-northeast1 · 싱가포르 asia-southeast1\n  벨기에 europe-west1 · 아이오와 us-central1\n나중에 바꾸려면 init을 다시 실행해 재배포해야 합니다.",
    regionPrompt: "리전",
    platformPrompt: "앱 플랫폼",
    platformOptions: {
      ios: "iOS (Swift / Objective-C)",
      android: "Android (Kotlin / Java)",
      auto: "둘 다 — 알림마다 자동 판별",
    },

    githubOwnerPrompt: "GitHub 소유자 (사용자 또는 조직)",
    githubRepoPrompt: "앱 소스 코드가 있는 GitHub 저장소",
    githubBranchPrompt: "수정 PR의 기준 브랜치",
    githubTokenTitle: "GitHub 토큰 만들기",
    githubTokenSteps: (owner, repo) => [
      "1. https://github.com/settings/personal-access-tokens/new 를 엽니다",
      `2. Resource owner: ${owner} (저장소가 조직 소유라면 조직을 선택)`,
      "3. Expiration: 만료일을 정하고 알림을 걸어두세요 — 토큰이 만료되면 봇이 멈춥니다",
      `4. Repository access → Only select repositories → ${repo}`,
      "5. Permissions → Repository permissions → Contents, Issues, Pull requests → Read and write",
      "6. Generate token을 누르고 토큰을 복사합니다 (한 번만 보여줍니다)",
      "조직 저장소라면 조직 소유자가 토큰을 승인해야 할 수 있습니다:",
      "  조직 Settings → Personal access tokens → Pending requests",
    ].join("\n"),
    githubTokenPrompt: "GitHub 토큰",

    anthropicTitle: "Anthropic API 키 만들기",
    anthropicSteps: [
      "1. https://console.anthropic.com 에서 가입하거나 로그인합니다",
      "2. Settings → Billing → 결제 수단을 등록하고 크레딧을 충전합니다",
      "   (크레딧이 없으면 모든 분석이 실패합니다)",
      "3. Settings → API Keys → Create Key → 이름 입력 (예: crashlytics-slack-bot)",
      "4. 키를 복사합니다 — sk-ant-로 시작하며 한 번만 보여줍니다",
      "크래시 알림 1건당 Claude 요청 1회(첫 시도가 실패해 재시도하면 2회), 수정 PR 1건당 1회가 추가로 쓰입니다.",
    ].join("\n"),
    anthropicPrompt: "Anthropic API 키",

    slackTitle: "Slack 앱 만들기",
    slackSteps: (link, url) => [
      "1. 아래 링크를 열면 설정이 미리 채워진 앱이 만들어집니다:",
      `   ${link}`,
      "   워크스페이스 선택 → Next → Create",
      "2. 왼쪽 메뉴 → Install App → Install to Workspace → 허용",
      "   \"Request to Install\"이 보이면 워크스페이스 관리자의 승인이 먼저 필요합니다.",
      "3. 왼쪽 메뉴 → OAuth & Permissions → Bot User OAuth Token 복사 (xoxb-로 시작)",
      "4. 왼쪽 메뉴 → Basic Information → App Credentials → Signing Secret → Show 클릭 후 복사",
      `Interactivity URL은 manifest에 이미 들어 있습니다: ${url}`,
    ].join("\n"),
    slackBotTokenPrompt: "Slack 봇 토큰 (Bot User OAuth Token, xoxb-…)",
    slackBotTokenFormat: "봇 토큰은 xoxb-로 시작합니다. OAuth & Permissions에서 복사하세요.",
    signingSecretPrompt: "Slack Signing Secret (Basic Information → App Credentials → Show 클릭 후 복사)",

    channelTitle: "Slack 채널 ID 찾기",
    channelSteps: [
      "1. Slack에서 알림을 받을 채널을 엽니다",
      "2. 상단의 채널 이름을 클릭합니다",
      "3. 정보(About) 탭 맨 아래의 채널 ID를 복사합니다 (예: C0123456789)",
    ].join("\n"),
    channelPrompt: "Slack 채널 ID",
    channelFormat: "채널 ID는 C0123456789 같은 형태입니다.",
    inviteBot: "해당 채널에서 `/invite @Crashlytics Bot`을 입력하세요. 비공개 채널은 봇을 초대하기 전까지 알림이 오지 않습니다.",

    checking: {
      github: "GitHub 접근 권한 확인 중…",
      anthropic: "Anthropic API 키와 크레딧 확인 중…",
      slack: "Slack 토큰 확인 중…",
    },
    checkOk: "확인 완료",
    checkFailed: "확인 실패",

    notEmpty: (dir) => `${dir} 폴더가 비어 있지 않습니다. 생성 파일을 덮어쓸까요?`,
    cancelledNothing: "설치를 취소했습니다 — 아무것도 변경하지 않았습니다.",
    created: (dir) => `${dir}/ 폴더를 만들었습니다`,
    storingSecrets: "Secret Manager에 시크릿 저장 중…",
    secretsStored: "시크릿 저장 완료",
    skipDeployOutro: (cmd) => `파일과 시크릿이 준비됐습니다. 배포하려면 실행하세요:\n  ${cmd}`,
    deployFailed: (cmd) => `배포에 실패했습니다. 위 오류를 해결한 뒤 실행하세요:\n  ${cmd}`,
    done: (dir) => `완료! 이제 새 Crashlytics 알림이 Slack에 옵니다.\n테스트 알림 보내기: npx crashlytics-slack-bot test --dir ${dir}`,
    cancelled: "설치를 취소했습니다.",

    errors: {
      github: {
        401: [
          "GitHub가 토큰이 잘못됐거나 만료됐다고 응답했습니다.",
          "• 토큰 전체를 붙여넣었는지 확인하세요 (github_pat_… 또는 ghp_…).",
          "• 만료됐거나 삭제됐다면 위 안내대로 새 토큰을 만드세요.",
        ].join("\n"),
        403: [
          "GitHub가 이 토큰의 접근을 거부했습니다.",
          "• 조직 저장소: 토큰이 조직 소유자의 승인을 기다리는 중일 수 있습니다",
          "  (조직 Settings → Personal access tokens → Pending requests).",
          "• 조직이 SAML SSO를 쓴다면 토큰에 SSO 권한을 부여하세요.",
          "• GitHub 요청 한도에 걸렸을 수 있습니다 — 1분 뒤 다시 시도하세요.",
        ].join("\n"),
        404: (owner, repo) => [
          `이 토큰으로 ${owner}/${repo} 저장소를 찾을 수 없습니다.`,
          "• 소유자와 저장소 이름에 오타가 없는지 확인하세요.",
          `• 토큰의 Repository access에 ${repo}가 포함돼 있는지 확인하세요`,
          "  (Settings → Developer settings → Personal access tokens → 토큰 → Edit).",
          "• 조직 저장소라면 토큰의 Resource owner가 조직이어야 합니다.",
        ].join("\n"),
        other: (status) => `GitHub가 HTTP ${status}를 반환했습니다. https://www.githubstatus.com 을 확인하고 다시 시도하세요.`,
      },
      anthropic: {
        401: [
          "Anthropic이 API 키가 잘못됐다고 응답했습니다.",
          "• 키 전체를 붙여넣었는지 확인하세요 (sk-ant-로 시작).",
          "• 삭제된 키라면 Settings → API Keys에서 새로 만드세요.",
        ].join("\n"),
        403: [
          "이 API 키로는 API를 호출할 수 없습니다.",
          "• 키가 속한 워크스페이스의 권한을 확인하거나, Default 워크스페이스에서 새 키를 만드세요.",
        ].join("\n"),
        credit: [
          "Anthropic 크레딧 잔액이 부족합니다.",
          "• https://console.anthropic.com → Settings → Billing 에서 크레딧을 충전한 뒤 다시 시도하세요.",
          "  충전한 크레딧이 반영되기까지 1분 정도 걸릴 수 있습니다.",
        ].join("\n"),
        other: (status) => `Anthropic이 HTTP ${status}를 반환했습니다. https://status.anthropic.com 을 확인하고 다시 시도하세요.`,
      },
      slack: {
        invalid_auth: [
          "Slack이 이 토큰을 인식하지 못합니다.",
          "• OAuth & Permissions의 Bot User OAuth Token(xoxb-…)을 복사하세요 —",
          "  Signing Secret, Client Secret, 앱 레벨 토큰이 아닙니다.",
        ].join("\n"),
        not_authed: "토큰이 Slack에 전달되지 않았습니다. Bot User OAuth Token(xoxb-…)을 다시 붙여넣으세요.",
        token_revoked: "폐기된 토큰입니다 — 앱이 삭제됐을 가능성이 큽니다.\n• 앱을 다시 설치하고(Install App → Reinstall to Workspace) 새 토큰을 복사하세요.",
        token_expired: "만료된 토큰입니다.\n• OAuth & Permissions → Advanced token security에서 토큰 순환(rotation)을 끄고, 앱을 다시 설치한 뒤 새 토큰을 복사하세요.",
        account_inactive: "앱 또는 워크스페이스가 비활성 상태입니다.\n• 앱을 워크스페이스에 다시 설치하고 새 토큰을 복사하세요.",
        other: (code) => `Slack이 "${code}" 오류를 반환했습니다. https://api.slack.com/methods/auth.test 에서 의미를 확인하세요.`,
      },
    },
  },
};

/**
 * Returns the wizard text for a language (falls back to English).
 * @param {string} [language]
 */
function wizardMessages(language) {
  return WIZARD[language] || WIZARD.en;
}

module.exports = { LANGUAGE_PROMPT, WIZARD, wizardMessages };
