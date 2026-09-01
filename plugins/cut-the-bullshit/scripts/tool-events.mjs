// Codex hook tool events are reduced before they reach disk. A bounded,
// redacted excerpt comes only from the host's PostToolUse payload; agent
// summaries and tool inputs are never promoted to evidence.

import crypto from "node:crypto";

const EXCERPT_CHARS = 2000;
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;

function redactString(value) {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/<redacted>")
    .replace(/\\Users\\[^\\\s]+/g, "\\Users\\<redacted>");
}

function redactValue(value, depth = 0) {
  if (depth > 6) return "[DEPTH LIMITED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
  }
  return out;
}

function resultValue(input) {
  if (Object.hasOwn(input, "tool_response")) return input.tool_response;
  if (Object.hasOwn(input, "tool_result")) return input.tool_result;
  if (Object.hasOwn(input, "result")) return input.result;
  return undefined;
}

export function resultEvidence(input) {
  const value = resultValue(input);
  if (value === undefined) return null;
  let raw;
  let redacted;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value);
    const safe = redactValue(value);
    redacted = typeof safe === "string" ? safe : JSON.stringify(safe);
  } catch {
    return null;
  }
  const excerpt = redacted.slice(0, EXCERPT_CHARS);
  return {
    source: "host_post_tool_use",
    result_bytes: Buffer.byteLength(raw),
    result_sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    excerpt,
    excerpt_truncated: redacted.length > excerpt.length,
  };
}

export function toolCategory(name) {
  const value = String(name ?? "").toLowerCase();
  if (/shell|exec|command|terminal|bash/.test(value)) return "shell";
  if (/read|open|view/.test(value)) return "read";
  if (/search|find|grep|glob|query/.test(value)) return "search";
  if (/write|edit|patch|create/.test(value)) return "write";
  if (/web|fetch|http|browser/.test(value)) return "network";
  if (/agent|task|collaboration/.test(value)) return "agent";
  return "other";
}

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function classifyPost(input) {
  const hasResponse = Object.hasOwn(input, "tool_response") || Object.hasOwn(input, "tool_result") || Object.hasOwn(input, "result");
  const response = input.tool_response ?? input.tool_result ?? input.result;
  const error = input.is_error === true || input.error != null ||
    response?.is_error === true || response?.error != null ||
    (Number.isInteger(response?.exit_code) && response.exit_code !== 0) ||
    (Number.isInteger(response?.exitCode) && response.exitCode !== 0);
  const truncated = input.truncated === true || input.is_truncated === true ||
    input.output_truncated === true || response?.truncated === true ||
    response?.is_truncated === true || response?.output_truncated === true;
  const explicitlyEmpty = input.no_result === true || input.no_output === true ||
    response?.no_result === true || response?.no_output === true;

  if (error) return { outcome: "failure", scope: truncated ? "truncated" : "observed" };
  if (truncated) return { outcome: "truncated", scope: "truncated" };
  if (explicitlyEmpty || (hasResponse && !present(response))) return { outcome: "no_result", scope: "none" };
  if (!hasResponse) return { outcome: "unknown", scope: "unknown" };
  return { outcome: "success", scope: "observed" };
}

export function preToolEvent(input) {
  return {
    tool_use_id: String(input.tool_use_id ?? ""),
    category: toolCategory(input.tool_name),
    outcome: "pending",
    scope: "unknown",
  };
}

export function postToolEvent(input, prior) {
  return {
    tool_use_id: String(input.tool_use_id ?? prior?.tool_use_id ?? ""),
    category: prior?.category ?? toolCategory(input.tool_name),
    ...classifyPost(input),
    evidence: resultEvidence(input),
  };
}
