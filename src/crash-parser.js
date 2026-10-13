"use strict";

// Common crash signatures per platform, used as hints for Claude.
const CRASH_PATTERNS = {
  ios: {
    "EXC_BAD_ACCESS": "Memory access violation — deallocated object, dangling pointer, force-unwrapped nil",
    "EXC_BREAKPOINT": "Swift runtime trap — force unwrap (!), fatalError(), array index out of range",
    "EXC_CRASH (SIGABRT)": "Explicit abort — assertion failure, uncaught exception, precondition failure",
    "EXC_RESOURCE": "Resource limit exceeded — memory limit, CPU usage, watchdog timeout",
    "EXC_BAD_INSTRUCTION": "Illegal instruction — implicitly unwrapped optional was nil",
    SIGABRT: "Process abort — NSException, fatalError, UI update off the main thread",
    SIGSEGV: "Segmentation fault — invalid memory access, C/C++ interop",
  },
  android: {
    NullPointerException: "Null dereference — lateinit not initialized, !! on null, platform type from Java",
    IllegalStateException: "Invalid state — Fragment not attached, lifecycle misuse, check()/error()",
    IllegalArgumentException: "Invalid argument — require() failed, bad navigation args",
    IndexOutOfBoundsException: "Index out of range on a list or array",
    ClassCastException: "Unsafe cast (as) between incompatible types",
    ConcurrentModificationException: "Collection modified while iterating",
    OutOfMemoryError: "Memory exhausted — large bitmaps, leaks",
    ANR: "Main thread blocked for more than 5 seconds",
  },
};

// Source extensions for iOS (Swift / Objective-C) and Android (Kotlin / Java)
const SOURCE_EXT = "(?:swift|mm|m|kt|java)";

/**
 * Detects the app platform from a Firebase app ID ("1:123:ios:abc" / "1:123:android:abc").
 * An explicitly configured platform ("ios" / "android") wins over detection.
 * @param {string} appId
 * @param {string} [configured] - "auto" | "ios" | "android"
 * @returns {"ios"|"android"|"unknown"}
 */
function detectPlatform(appId, configured) {
  if (configured && configured !== "auto") return configured;
  if (/:ios:/.test(appId || "")) return "ios";
  if (/:android:/.test(appId || "")) return "android";
  return "unknown";
}

/**
 * Extracts source file names and line numbers from a Crashlytics issue.
 * @param {{title?: string, subtitle?: string}} issue
 * @param {string} [platform] - used to infer the file extension from Class.method(
 * @returns {Array<{file: string, line: number|null}>}
 */
function extractFileInfoFromIssue(issue, platform) {
  const files = [];
  const combined = `${issue.title || ""} ${issue.subtitle || ""}`;
  const has = (file) => files.some((f) => f.file === file);
  let match;

  // Pattern 1: File.swift:123 / File.kt:123 (also Android frames "at a.b.C.m(File.kt:42)")
  const fileLinePattern = new RegExp(`([\\w$]+\\.${SOURCE_EXT}):(\\d+)`, "g");
  while ((match = fileLinePattern.exec(combined)) !== null) {
    if (!has(match[1])) files.push({ file: match[1], line: parseInt(match[2]) });
  }

  // Pattern 2: File.swift ... line 123
  const fileLineSeparatePattern = new RegExp(`([\\w$]+\\.${SOURCE_EXT})\\b.*?\\bline\\s+(\\d+)`, "gi");
  while ((match = fileLineSeparatePattern.exec(combined)) !== null) {
    if (!has(match[1])) files.push({ file: match[1], line: parseInt(match[2]) });
  }

  // Pattern 3: File.swift on its own
  const fileOnlyPattern = new RegExp(`([\\w$]+\\.${SOURCE_EXT})\\b`, "g");
  while ((match = fileOnlyPattern.exec(combined)) !== null) {
    if (!has(match[1])) files.push({ file: match[1], line: null });
  }

  // Pattern 4: ClassName.methodName( → infer ClassName.<ext> (only if 1–3 found nothing)
  if (files.length === 0) {
    const ext = platform === "android" ? "kt" : "swift";
    const classPattern = /(\w+)\.\w+\(/g;
    while ((match = classPattern.exec(combined)) !== null) {
      const inferredFile = `${match[1]}.${ext}`;
      if (!has(inferredFile)) files.push({ file: inferredFile, line: null });
    }
  }

  return files;
}

/**
 * Returns hints for known crash signatures found in the crash title.
 * @param {string} crashTitle
 * @param {string} [platform]
 * @returns {string}
 */
function getPatternHint(crashTitle, platform) {
  const upper = (crashTitle || "").toUpperCase();
  const patterns = CRASH_PATTERNS[platform] || { ...CRASH_PATTERNS.ios, ...CRASH_PATTERNS.android };
  const hints = Object.entries(patterns)
    .filter(([key]) => upper.includes(key.toUpperCase()))
    .map(([, desc]) => `• ${desc}`)
    .join("\n");
  return hints || "No known crash pattern matched";
}

module.exports = {
  CRASH_PATTERNS,
  detectPlatform,
  extractFileInfoFromIssue,
  getPatternHint,
};
