"use strict";

const crypto = require("crypto");

// Slack은 5분 이상 지난 요청을 재전송(replay) 공격으로 간주하도록 권장한다.
const MAX_AGE_SECONDS = 60 * 5;

/**
 * Slack 요청 서명(X-Slack-Signature)을 검증합니다.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param {Object} params
 * @param {string} params.signingSecret - Slack 앱의 Signing Secret
 * @param {string|Buffer} params.rawBody - 파싱 전 요청 본문
 * @param {string} params.timestamp - X-Slack-Request-Timestamp 헤더
 * @param {string} params.signature - X-Slack-Signature 헤더
 * @param {number} [params.now] - 현재 시각(ms), 테스트용
 * @returns {boolean}
 */
function verifySlackSignature({ signingSecret, rawBody, timestamp, signature, now = Date.now() }) {
  if (!signingSecret || !rawBody || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_AGE_SECONDS) return false;

  const expected = "v0=" + crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifySlackSignature, MAX_AGE_SECONDS };
