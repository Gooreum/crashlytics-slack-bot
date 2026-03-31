"use strict";

// iOS 크래시 패턴 사전
const IOS_CRASH_PATTERNS = {
  "EXC_BAD_ACCESS":
    "메모리 접근 위반 — 해제된 객체 접근, 댕글링 포인터, force unwrap nil",
  "EXC_BREAKPOINT":
    "Swift 런타임 에러 — force unwrap(!), fatalError(), 배열 인덱스 초과",
  "EXC_CRASH (SIGABRT)":
    "명시적 abort — assertion failure, uncaught exception, precondition 실패",
  "EXC_RESOURCE":
    "리소스 한도 초과 — 메모리 제한, CPU 과사용, Watchdog 타임아웃",
  "EXC_BAD_INSTRUCTION":
    "잘못된 명령어 — implicitly unwrapped optional이 nil",
  SIGABRT:
    "프로세스 abort — NSException, fatalError, 메인스레드 외 UI 업데이트",
  SIGSEGV: "세그멘테이션 폴트 — 잘못된 메모리 접근, C/C++ interop 관련",
};

/**
 * iOS 스택트레이스를 파싱하여 프레임 배열을 반환합니다.
 * @param {string} stacktrace
 * @returns {Array<{frameNumber, module, method, file, line}>}
 */
function parseIosStacktrace(stacktrace) {
  if (!stacktrace) return [];
  const frames = [];
  const symbolicated =
    /(\d+)\s+(\S+)\s+0x[\da-f]+\s+(.+?)\s+\+\s+\d+\s+\((\S+\.swift):(\d+)\)/gi;
  const titlePattern = /(\w+\.swift)\s+line\s+(\d+)\s+in\s+(\S+)/gi;
  let match;
  while ((match = symbolicated.exec(stacktrace)) !== null) {
    frames.push({
      frameNumber: parseInt(match[1]),
      module: match[2],
      method: match[3].trim(),
      file: match[4],
      line: parseInt(match[5]),
    });
  }
  while ((match = titlePattern.exec(stacktrace)) !== null) {
    frames.push({
      frameNumber: 0,
      module: "App",
      method: match[3].trim(),
      file: match[1],
      line: parseInt(match[2]),
    });
  }
  return frames;
}

/**
 * Crashlytics 이슈 정보에서 Swift 파일명과 라인 번호를 추출합니다.
 * @param {{title?: string, subtitle?: string}} issue
 * @returns {Array<{file: string, line: number|null}>}
 */
function extractFileInfoFromIssue(issue) {
  const files = [];
  const combined = `${issue.title || ""} ${issue.subtitle || ""}`;

  // 패턴 1: File.swift:123
  const fileLinePattern = /(\w+\.swift):(\d+)/g;
  let match;
  while ((match = fileLinePattern.exec(combined)) !== null) {
    files.push({ file: match[1], line: parseInt(match[2]) });
  }

  // 패턴 2: File.swift ... line 123
  const fileLineSeparatePattern = /(\w+\.swift)\b.*?\bline\s+(\d+)/gi;
  while ((match = fileLineSeparatePattern.exec(combined)) !== null) {
    if (!files.some((f) => f.file === match[1])) {
      files.push({ file: match[1], line: parseInt(match[2]) });
    }
  }

  // 패턴 3: File.swift 단독
  const fileOnlyPattern = /(\w+\.swift)\b/g;
  while ((match = fileOnlyPattern.exec(combined)) !== null) {
    if (!files.some((f) => f.file === match[1])) {
      files.push({ file: match[1], line: null });
    }
  }

  // 패턴 4: ClassName.methodName( → ClassName.swift 추론 (패턴 1~3 실패 시만)
  if (files.length === 0) {
    const classPattern = /(\w+)\.\w+\(/g;
    while ((match = classPattern.exec(combined)) !== null) {
      const inferredFile = `${match[1]}.swift`;
      if (!files.some((f) => f.file === inferredFile)) {
        files.push({ file: inferredFile, line: null });
      }
    }
  }

  return files;
}

/**
 * 크래시 타이틀에서 일치하는 iOS 크래시 패턴 설명을 반환합니다.
 * @param {string} crashTitle
 * @returns {string}
 */
function getPatternHint(crashTitle) {
  const upper = (crashTitle || "").toUpperCase();
  const hints = Object.entries(IOS_CRASH_PATTERNS)
    .filter(([key]) => upper.includes(key))
    .map(([, desc]) => `• ${desc}`)
    .join("\n");
  return hints || "특정 패턴 매칭 없음";
}

module.exports = {
  IOS_CRASH_PATTERNS,
  parseIosStacktrace,
  extractFileInfoFromIssue,
  getPatternHint,
};
