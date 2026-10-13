"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LANGUAGE_PROMPT, WIZARD, wizardMessages } = require("../src/cli/messages");

function keyPaths(obj, prefix = "") {
  return Object.entries(obj).flatMap(([key, value]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" && !Array.isArray(value) ? keyPaths(value, p) : [p];
  });
}

function functionPaths(obj, prefix = "") {
  return Object.entries(obj).flatMap(([key, value]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "function") return [[p, value]];
    return value && typeof value === "object" && !Array.isArray(value) ? functionPaths(value, p) : [];
  });
}

test("TC-1 en and ko define the same nested keys", () => {
  assert.deepEqual(keyPaths(WIZARD.ko).sort(), keyPaths(WIZARD.en).sort());
});

test("TC-2 every function message renders its arguments in both languages", () => {
  for (const language of ["en", "ko"]) {
    const fns = functionPaths(WIZARD[language]);
    assert.ok(fns.length >= 10, language);
    for (const [p, fn] of fns) {
      const args = Array.from({ length: fn.length }, (_, i) => `ARG${i}`);
      const text = fn(...args);
      assert.equal(typeof text, "string", `${language}.${p}`);
      for (const arg of args) assert.ok(text.includes(arg), `${language}.${p} missing ${arg}`);
    }
  }
});

test("TC-3 unknown or missing language falls back to English", () => {
  assert.equal(wizardMessages(undefined), WIZARD.en);
  assert.equal(wizardMessages("fr"), WIZARD.en);
  assert.equal(wizardMessages("ko"), WIZARD.ko);
});

test("TC-4 checklist covers all five prerequisites in both languages", () => {
  for (const language of ["en", "ko"]) {
    const { checklist } = WIZARD[language];
    assert.equal(checklist.length, 5);
    const text = checklist.join("\n");
    for (const word of ["Blaze", "Crashlytics", "Slack", "GitHub", "Anthropic"]) {
      assert.ok(text.includes(word), `${language} ${word}`);
    }
  }
});

test("TC-5 language prompt is bilingual", () => {
  assert.equal(LANGUAGE_PROMPT, "Language / 언어");
});
