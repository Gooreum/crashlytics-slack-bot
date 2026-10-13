"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { getPatternHint } = require("./crash-parser");
const { t } = require("./i18n");

// On a policy refusal the API re-runs the request on Anthropic's recommended fallback model.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const FIX_SCHEMA = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          fixedCode: { type: "string" },
          summary: { type: "string" },
        },
        required: ["filePath", "fixedCode", "summary"],
        additionalProperties: false,
      },
    },
    prTitle: { type: "string" },
    prDescription: { type: "string" },
  },
  required: ["fixes", "prTitle", "prDescription"],
  additionalProperties: false,
};

const FENCE_LANGUAGES = { swift: "swift", m: "objectivec", mm: "objectivec", kt: "kotlin", java: "java" };

function fenceLanguage(filePath) {
  const ext = (filePath || "").split(".").pop();
  return FENCE_LANGUAGES[ext] || "";
}

function platformExpertise(platform) {
  if (platform === "android") return "Android/Kotlin";
  if (platform === "ios") return "iOS/Swift";
  return "mobile (iOS/Swift and Android/Kotlin)";
}

class ClaudeService {
  constructor(config, logger, client = new Anthropic({ apiKey: config.claude.apiKey })) {
    this.client = client;
    this.model = config.claude.model;
    this.msg = t(config.language);
    this.logger = logger;
  }

  /**
   * Sends a request and returns the response text, or null on refusal.
   * Streams so long full-file fixes don't hit HTTP timeouts.
   */
  async _request(params) {
    const message = await this.client.beta.messages.stream({
      model: this.model,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      ...params,
    }).finalMessage();

    if (message.stop_reason === "refusal") {
      this.logger.warn("Claude declined the request:", message.stop_details?.category || "unknown");
      return null;
    }
    if (message.stop_reason === "max_tokens") {
      this.logger.warn("⚠️ Claude response was truncated (max_tokens)");
    }
    return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  /**
   * Analyzes a crash using the crash info and related source code.
   * @param {{title, subtitle, appVersion}} issue
   * @param {string} typeLabel
   * @param {Array} sourceResults
   * @param {string} [platform] - "ios" | "android" | "unknown"
   * @returns {Promise<string|null>}
   */
  async analyze(issue, typeLabel, sourceResults, platform) {
    try {
      const patternHint = getPatternHint(issue.title, platform);

      let sourceContext = "Source code lookup was skipped or failed.";
      if (sourceResults && sourceResults.length > 0) {
        sourceContext = sourceResults.map((r) => {
          if (r.error) return `### ${r.file} (line ${r.line || "N/A"})\nLookup failed: ${r.error}`;
          return `### ${r.filePath} (crash line: ${r.line || "N/A"})
\`\`\`${fenceLanguage(r.filePath)}
${r.content}
\`\`\`

**Recent commits:**
${r.recentCommits}`;
        }).join("\n\n");
      }

      const prompt = `You are an expert in ${platformExpertise(platform)} crash analysis. Analyze this crash reported by Firebase Crashlytics.

## Crash
- Alert type: ${typeLabel}
- Error: ${issue.title || "N/A"}
- Details (method/location): ${issue.subtitle || "N/A"}
- App version: ${issue.appVersion || "N/A"}

## Known crash patterns
${patternHint}

## Related source code (from GitHub)
${sourceContext}

---

Cover the following:

1. **🔍 Root cause** — Combine the error, method, and source to explain exactly why it crashes.
2. **🔄 Reproduction** — One or two user flows that can trigger this crash.
3. **🛠️ Fix** — A concrete code patch with appropriate defensive handling.
4. **🛡️ Prevention** — Additional defensive logic that prevents this class of crash.
5. **⚠️ Other risky spots** — Places in the same file or project with a similar risk.

This will be shown in Slack: use concise Markdown, 3–5 sentences per section.
Write the entire response in ${this.msg.languageName}.`;

      return await this._request({
        max_tokens: 16000,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: prompt }],
      });
    } catch (error) {
      this.logger.error("Claude analysis failed:", error.message);
      return null;
    }
  }

  /**
   * Generates fixed file contents for a PR.
   * @param {{title, subtitle}} issue
   * @param {Array} sourceResults
   * @returns {Promise<{fixes, prTitle, prDescription}|null>}
   */
  async generateFix(issue, sourceResults) {
    const fixableFiles = sourceResults.filter((r) => !r.error && r.fullContent);
    if (fixableFiles.length === 0) {
      this.logger.warn("No fixable source files; skipping PR generation.");
      return null;
    }

    try {
      const filesContext = fixableFiles.map((r) =>
        `### File: ${r.filePath} (crash line: ${r.line || "N/A"})
\`\`\`${fenceLanguage(r.filePath)}
${r.fullContent}
\`\`\``
      ).join("\n\n");

      const prompt = `You are a senior mobile engineer fixing a production crash.

## Crash
- Error: ${issue.title || "N/A"}
- Details: ${issue.subtitle || "N/A"}

## Source files to fix (full contents)
${filesContext}

---

Fix this crash.

Rules:
- \`filePath\` must be the exact path shown above.
- \`fixedCode\` must be the **complete** fixed file, not a diff.
- Keep the existing structure and style; change only what is needed to fix the crash.
- Use the platform's safe idioms (e.g. guard let / optional chaining in Swift, null-safety and ?. / ?: in Kotlin).
- Write \`summary\`, \`prTitle\`, and \`prDescription\` (Markdown) in ${this.msg.languageName}.`;

      const text = await this._request({
        max_tokens: 64000,
        output_config: { effort: "high", format: { type: "json_schema", schema: FIX_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      });
      if (!text) return null;

      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.fixes) || parsed.fixes.length === 0) {
        this.logger.error("Claude returned no fixes.");
        return null;
      }
      return parsed;
    } catch (error) {
      this.logger.error("Claude fix generation failed:", error.message);
      return null;
    }
  }
}

module.exports = { ClaudeService, FIX_SCHEMA };
