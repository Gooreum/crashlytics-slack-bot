# crashlytics-slack-bot

Get Firebase Crashlytics alerts in Slack, analyzed by Claude, with one-click GitHub issues and AI-generated fix PRs. Works with iOS (Swift / Objective-C) and Android (Kotlin / Java) apps.

```
🔥 New fatal issue                         ← posted the moment Crashlytics alerts
   Platform: 🍎 iOS · App version: 2.3.1
   Error: EXC_BREAKPOINT
   Details: UserService.swift line 53
   └─ 🤖 AI crash analysis                 ← thread reply a minute later
      Root cause · Reproduction · Fix · Prevention · Other risky spots
      📂 App/Services/UserService.swift:53
      [🐛 Create GitHub Issue]  [🔀 Create fix PR]
```

## Quick start

You need Node.js 20+, the [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`, then `firebase login`), and a Firebase project on the **Blaze** plan with Crashlytics enabled.

Run this from your app's repository so the GitHub repo is detected automatically:

```bash
npx crashlytics-slack-bot init
```

The wizard:

1. Asks for a language (English or Korean). The rest of the wizard, the Slack messages, and the AI analysis use it.
2. Shows a checklist of prerequisites and stops, changing nothing, if you're not ready yet.
3. Asks for your Firebase project, region, and platform.
4. Shows numbered steps for creating each credential right before asking for it, then checks it against the real API. If a check fails, the wizard says what's wrong and how to fix it, then asks again.
5. Gives you a link that creates the Slack app from a pre-filled manifest, with the interactivity URL already set.
6. Writes a `crashlytics-slack-bot/` folder, stores the secrets in Secret Manager, and deploys.

Then send a sample crash to check the connection:

```bash
npx crashlytics-slack-bot test
```

`test` runs the pipeline from your machine with the deployed config and secrets, and posts a 🧪 test alert. Click the Issue/PR buttons in its thread to test the deployed function too. Use `--file UserService.swift --line 53` to point the sample crash at a real file.

### What you need to create

| Credential | Where | Notes |
|---|---|---|
| GitHub token | [Fine-grained token](https://github.com/settings/personal-access-tokens/new) | Access to your app repo. Contents, Pull requests, and Issues: read & write |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Requires credits (*Settings → Billing*). `init` sends a one-token request to confirm the key works and has credits |
| Slack bot token and signing secret | The Slack app created from the wizard's link | Bot token: *OAuth & Permissions*. Signing secret: *Basic Information*. Invite the bot to your alert channel with `/invite @Crashlytics Bot` |

## How it works

```
Crashlytics alert (Firebase Alerts trigger)
  → Slack alert, posted immediately
  → Source files found from the crash location, fetched from GitHub
  → Claude analyzes the crash with the source and recent commits
  → Analysis posted in the alert's thread, with buttons
  → [button] GitHub issue, or a fix PR written by Claude
```

`init` deploys these Cloud Functions in their own codebase (`crashlytics-slack-bot`), so `firebase deploy` never touches your project's other functions:

| Function | Trigger |
|---|---|
| `crashlyticsNewFatal` | New fatal issue |
| `crashlyticsNewNonfatal` | New non-fatal issue |
| `crashlyticsRegression` | Regressed issue |
| `crashlyticsVelocity` | Trending issue (velocity alert) |
| `crashlyticsNewAnr` | New ANR issue (Android) |
| `crashlyticsSlackInteraction` | HTTPS endpoint for Slack button clicks |

## Manual setup

If you already have a Cloud Functions project, add the package and export the functions yourself:

```bash
cd functions
npm install crashlytics-slack-bot firebase-functions firebase-admin
```

```js
// functions/index.js
const { createFunctions } = require("crashlytics-slack-bot");

// Adds crashlyticsNewFatal, crashlyticsSlackInteraction, … next to your other exports
Object.assign(exports, createFunctions({
  github: { owner: "your-org", repo: "your-app", branch: "main" },
  slack: { channelId: "C0123456789" },
  firebase: { projectId: "your-project", region: "us-central1" },
  platform: "auto",
  language: "en",
}));
```

Store the secrets, then deploy:

```bash
firebase functions:secrets:set SLACK_BOT_TOKEN
firebase functions:secrets:set SLACK_SIGNING_SECRET
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set GITHUB_TOKEN
firebase deploy --only functions
```

Create the Slack app with the bot scopes `chat:write` and `reactions:write`, enable *Interactivity*, and set its request URL to:

```
https://<region>-<project-id>.cloudfunctions.net/crashlyticsSlackInteraction
```

### Using the bot directly

`createCrashlyticsBot` gives you the pipeline without the Firebase wiring, for custom triggers or other hosts:

```js
const { createCrashlyticsBot } = require("crashlytics-slack-bot");

const bot = createCrashlyticsBot({
  github: { owner: "your-org", repo: "your-app", token: process.env.GITHUB_TOKEN },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    channelId: "C0123456789",
  },
  claude: { apiKey: process.env.ANTHROPIC_API_KEY },
});

await bot.analyzeCrash(crashlyticsEvent, "fatal");           // built-in label and emoji
await bot.analyzeCrash(crashlyticsEvent, "Custom label", "🧪"); // your own
app.post("/slack/interactions", bot.handleSlackInteraction); // needs req.rawBody
```

## Configuration

`init` writes these settings to `functions/crashlytics-slack-bot.config.json`. Tokens and keys are never stored there; they live in Secret Manager.

| Key | Default | Description |
|---|---|---|
| `github.owner` | required | GitHub user or organization |
| `github.repo` | required | Repository with the app's source code |
| `github.branch` | `"main"` | Branch to read source from and open fix PRs against |
| `slack.channelId` | required | Channel for alerts |
| `firebase.projectId` | `""` | Used for "View in Firebase Console" links |
| `firebase.region` | `"us-central1"` | Cloud Functions region (`createFunctions` only) |
| `firebase.appId` | all apps | Only handle alerts for this Firebase app ID (`createFunctions` only) |
| `alerts` | all | Alert types to subscribe to: `fatal`, `nonfatal`, `regression`, `velocity`, `anr` (`createFunctions` only) |
| `platform` | `"auto"` | `ios`, `android`, or `auto` (detect from each alert's app ID) |
| `language` | `"en"` | `en` or `ko`, for Slack messages, GitHub issues/PRs, and the analysis |
| `claude.model` | `"claude-opus-5-5"` | Claude model for analysis and fixes. `claude-sonnet-5-5` costs less |
| `logger` | `console` | Object with `log`, `warn`, `error` |

With `createCrashlyticsBot`, also pass `github.token`, `slack.botToken`, `slack.signingSecret`, and `claude.apiKey`. With `createFunctions`, they come from the secrets `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `ANTHROPIC_API_KEY`.

## Security and cost

- **Slack requests are verified.** Button clicks are accepted only with a valid `X-Slack-Signature` made with your signing secret, and requests older than 5 minutes are rejected.
- **Review AI pull requests before merging.** Claude writes complete files for fix PRs. Every PR is labeled `ai-fix` and says it was generated by AI.
- **Secrets stay out of files and command lines.** `init` passes them to `firebase functions:secrets:set` on stdin.
- **Each alert makes one Claude request, and each fix PR makes one more.** On a noisy app, subscribe only to the alerts you need with `alerts`, or choose a cheaper `claude.model`.

## Upgrading from 1.x

- Add the `SLACK_SIGNING_SECRET` secret (Slack app → *Basic Information*) and pass it as `slack.signingSecret`.
- Messages now default to English. Set `language: "ko"` to keep the Korean messages.
- The default model is now `claude-opus-5-5`.

## License

MIT
