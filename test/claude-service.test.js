"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ClaudeService } = require("../src/claude-service");
const { createConfig } = require("../src/config");
const { baseConfig } = require("./helpers");

function mockClient(response) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(params);
          return {
            finalMessage: async () => {
              if (response instanceof Error) throw response;
              return response;
            },
          };
        },
      },
    },
  };
}

function recordingLogger() {
  const logs = { warn: [], error: [] };
  return { logs, log() {}, warn: (...a) => logs.warn.push(a.join(" ")), error: (...a) => logs.error.push(a.join(" ")) };
}

const textResponse = (text, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text }] });
const issue = { title: "EXC_BREAKPOINT", subtitle: "Foo.swift line 3", appVersion: "1.0" };
const swiftSource = [{ file: "Foo.swift", filePath: "App/Foo.swift", line: 3, content: "x", fullContent: "let x = y!", recentCommits: "" }];

test("TC-1 analyze sends model, fallbacks, and medium effort", async () => {
  const client = mockClient(textResponse("analysis"));
  const service = new ClaudeService(createConfig(baseConfig()), recordingLogger(), client);
  const result = await service.analyze(issue, "New fatal issue", swiftSource, "ios");
  assert.equal(result, "analysis");
  const req = client.requests[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.output_config.effort, "medium");
});

test("TC-2 analyze prompt reflects platform, code fence, and language", async () => {
  const client = mockClient(textResponse("분석"));
  const service = new ClaudeService(createConfig(baseConfig({ language: "ko" })), recordingLogger(), client);
  const kotlin = [{ file: "Main.kt", filePath: "app/Main.kt", line: 1, content: "val x = y!!", recentCommits: "" }];
  await service.analyze({ title: "NullPointerException" }, "label", kotlin, "android");
  const prompt = client.requests[0].messages[0].content;
  assert.ok(prompt.includes("Android/Kotlin"));
  assert.ok(prompt.includes("```kotlin"));
  assert.ok(prompt.includes("Write the entire response in Korean."));
});

test("TC-3 generateFix requests structured JSON and parses it", async () => {
  const fix = { fixes: [{ filePath: "App/Foo.swift", fixedCode: "let x = y ?? 0", summary: "nil-safe" }], prTitle: "Fix crash", prDescription: "desc" };
  const client = mockClient(textResponse(JSON.stringify(fix)));
  const service = new ClaudeService(createConfig(baseConfig()), recordingLogger(), client);
  const result = await service.generateFix(issue, swiftSource);
  assert.deepEqual(result, fix);
  const req = client.requests[0];
  assert.equal(req.output_config.format.type, "json_schema");
  assert.deepEqual(req.output_config.format.schema.required, ["fixes", "prTitle", "prDescription"]);
  assert.equal(req.output_config.effort, "high");
});

test("TC-4 refusals return null with a warning", async () => {
  const logger = recordingLogger();
  const refusal = { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] };
  const service = new ClaudeService(createConfig(baseConfig()), logger, mockClient(refusal));
  assert.equal(await service.analyze(issue, "label", [], "ios"), null);
  assert.equal(await service.generateFix(issue, swiftSource), null);
  assert.ok(logger.logs.warn.some((w) => w.includes("declined") && w.includes("cyber")));
});

test("TC-5 generateFix skips the API when nothing is fixable", async () => {
  const client = mockClient(textResponse("{}"));
  const service = new ClaudeService(createConfig(baseConfig()), recordingLogger(), client);
  assert.equal(await service.generateFix(issue, [{ file: "Foo.swift", error: "File not found" }]), null);
  assert.equal(client.requests.length, 0);
});

test("TC-6 generateFix returns null for empty fixes or invalid JSON", async () => {
  const empty = new ClaudeService(createConfig(baseConfig()), recordingLogger(),
    mockClient(textResponse(JSON.stringify({ fixes: [], prTitle: "", prDescription: "" }))));
  assert.equal(await empty.generateFix(issue, swiftSource), null);
  const invalid = new ClaudeService(createConfig(baseConfig()), recordingLogger(), mockClient(textResponse("{not json")));
  assert.equal(await invalid.generateFix(issue, swiftSource), null);
});

test("TC-7 API errors are logged and swallowed", async () => {
  const logger = recordingLogger();
  const service = new ClaudeService(createConfig(baseConfig()), logger, mockClient(new Error("ECONNRESET")));
  assert.equal(await service.analyze(issue, "label", [], "ios"), null);
  assert.equal(await service.generateFix(issue, swiftSource), null);
  assert.equal(logger.logs.error.length, 2);
});

test("TC-8 custom model is used", async () => {
  const cfg = baseConfig();
  cfg.claude.model = "claude-sonnet-5-5";
  const client = mockClient(textResponse("ok"));
  await new ClaudeService(createConfig(cfg), recordingLogger(), client).analyze(issue, "label", [], "ios");
  assert.equal(client.requests[0].model, "claude-sonnet-5-5");
});

test("TC-9 Hangul only appears in src/i18n.js", () => {
  const srcDir = path.join(__dirname, "..", "src");
  const offenders = fs.readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith(".js") && f !== "i18n.js")
    .filter((f) => /[가-힣]/.test(fs.readFileSync(path.join(srcDir, f), "utf8")));
  assert.deepEqual(offenders, []);
});
