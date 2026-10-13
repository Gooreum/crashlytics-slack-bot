"use strict";

const crypto = require("crypto");

// Slack recommends rejecting requests older than 5 minutes to prevent replay attacks.
const MAX_AGE_SECONDS = 60 * 5;

/**
 * Verifies a Slack request signature (X-Slack-Signature).
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param {Object} params
 * @param {string} params.signingSecret - Slack app signing secret
 * @param {string|Buffer} params.rawBody - Unparsed request body
 * @param {string} params.timestamp - X-Slack-Request-Timestamp header
 * @param {string} params.signature - X-Slack-Signature header
 * @param {number} [params.now] - Current time in ms (for tests)
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
