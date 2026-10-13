"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectPlatform, extractFileInfoFromIssue, getPatternHint } = require("../src/crash-parser");
const { createConfig } = require("../src/config");
const { SlackService } = require("../src/slack-service");
const { baseConfig, silentLogger } = require("./helpers");

test("TC-1 extracts Kotlin file and line", () => {
  const files = extractFileInfoFromIssue({
    title: "java.lang.IllegalStateException",
    subtitle: "com.app.ui.ProfileFragment.onViewCreated (ProfileFragment.kt:42)",
  }, "android");
  assert.deepEqual(files, [{ file: "ProfileFragment.kt", line: 42 }]);
});

test("TC-2 extracts Java file and line from a stack frame", () => {
  const files = extractFileInfoFromIssue({ subtitle: "at com.app.Repo.load(UserRepository.java:118)" }, "android");
  assert.deepEqual(files, [{ file: "UserRepository.java", line: 118 }]);
});

test("TC-3 keeps the existing Swift behavior", () => {
  const files = extractFileInfoFromIssue({
    title: "EXC_BREAKPOINT",
    subtitle: "CrashScenarios.swift - UserService.getCurrentUserName() line 53",
  });
  assert.deepEqual(files, [{ file: "CrashScenarios.swift", line: 53 }]);
});

test("TC-4 infers a Kotlin file from Class.method( on Android", () => {
  assert.deepEqual(extractFileInfoFromIssue({ subtitle: "UserService.getUser(id)" }, "android"), [{ file: "UserService.kt", line: null }]);
});

test("TC-5 infers a Swift file from Class.method( on iOS or unknown", () => {
  assert.deepEqual(extractFileInfoFromIssue({ subtitle: "UserService.getUser(id)" }, "ios"), [{ file: "UserService.swift", line: null }]);
  assert.deepEqual(extractFileInfoFromIssue({ subtitle: "UserService.getUser(id)" }), [{ file: "UserService.swift", line: null }]);
});

test("TC-6 detects platform from app ID, configured value wins", () => {
  assert.equal(detectPlatform("1:1:ios:a"), "ios");
  assert.equal(detectPlatform("1:1:android:a"), "android");
  assert.equal(detectPlatform(""), "unknown");
  assert.equal(detectPlatform(undefined, "auto"), "unknown");
  assert.equal(detectPlatform("1:1:ios:a", "android"), "android");
});

test("TC-7 Android pattern hints", () => {
  const hint = getPatternHint("java.lang.NullPointerException", "android");
  assert.ok(hint.includes("Null dereference"));
  assert.ok(!hint.includes("Swift"));
});

test("TC-8 no matching pattern", () => {
  assert.equal(getPatternHint("SomethingElse", "android"), "No known crash pattern matched");
});

function fakeSlackClient() {
  const calls = [];
  return { calls, chat: { postMessage: async (args) => { calls.push(args); return { ts: "1" }; } } };
}
const issue = { title: "x", subtitle: "y", appVersion: "1" };

test("TC-9 Android app ID is shown as Android", async () => {
  const client = fakeSlackClient();
  await new SlackService(createConfig(baseConfig()), silentLogger, client)
    .postInitialAlert({ appId: "1:1:android:a", data: { payload: { issue } } }, "label", "🔥");
  assert.ok(JSON.stringify(client.calls[0].blocks).includes("🤖 Android"));
});

test("TC-10 configured platform wins when app ID is missing", async () => {
  const client = fakeSlackClient();
  await new SlackService(createConfig(baseConfig({ platform: "ios" })), silentLogger, client)
    .postInitialAlert({ data: { payload: { issue } } }, "label", "🔥");
  assert.ok(JSON.stringify(client.calls[0].blocks).includes("🍎 iOS"));
});
