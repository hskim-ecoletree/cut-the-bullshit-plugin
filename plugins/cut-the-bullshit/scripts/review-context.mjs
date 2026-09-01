#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function stateArgument(argv) {
  const at = argv.indexOf("--state");
  if (at < 0 || !argv[at + 1] || argv.length !== 2) fail("사용법: review-context.mjs --state <턴 상태 파일>");
  return path.resolve(argv[at + 1]);
}

function readState(target) {
  if (!/^[a-f0-9]{64}\.json$/.test(path.basename(target)) || path.basename(path.dirname(target)) !== "turns") {
    fail("턴 상태 파일 이름이 올바르지 않다.");
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch { fail("턴 상태 파일을 읽을 수 없다."); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail("안전한 턴 상태 파일이 아니다.");
  let state;
  try { state = JSON.parse(fs.readFileSync(target, "utf8")); } catch { fail("턴 상태 JSON을 읽을 수 없다."); }
  if (state?.version !== 2 || !Array.isArray(state.tools) || !state.request || !state.features) {
    fail("지원하지 않는 턴 상태 형식이다.");
  }
  if (Number.isFinite(state.expires_at) && state.expires_at <= Date.now()) fail("턴 상태의 보존 기한이 지났다.");
  return state;
}

function renderEvidence(state) {
  const events = state.tools.filter((event) => event.category !== "agent" && event.internal_review !== true);
  if (events.length === 0) return "관찰 정보 없음";
  return events.map((event, index) => {
    const evidence = event.evidence;
    const head = `E${index + 1} · ${event.category} · ${event.outcome} · 범위=${event.scope}`;
    if (!evidence || evidence.source !== "host_post_tool_use") return `${head}\n결과 조각 없음`;
    const cut = evidence.excerpt_truncated ? " · 조각 뒤가 생략됨" : "";
    return [
      `${head} · host PostToolUse · ${evidence.result_bytes}바이트${cut}`,
      `sha256:${evidence.result_sha256}`,
      "<<<결과 조각 시작>>>",
      evidence.excerpt,
      "<<<결과 조각 끝>>>",
    ].join("\n");
  }).join("\n\n");
}

function render(state) {
  const conversation = {
    request_kind: state.request.kind,
    agreed_facts: [],
    unsettled_claims: [],
    agreed_terms: [],
    rejected_or_unclear_expressions: [],
    open_questions: [],
    commitments: [],
    authority: { user_decides: [], agent_may_execute: [] },
  };
  return [
    "[호스트가 기록한 이번 turn 도구 근거]",
    renderEvidence(state),
    "",
    "[작은 대화 상태 — 아래 빈 배열은 실제 대화에서 확인한 내용만 채운다]",
    JSON.stringify(conversation, null, 2),
    "사용자의 전문성은 추측하지 않는다. 사용자가 실제로 쓴 용어와 이해하지 못했거나 거부한 표현만 옮긴다.",
    "",
    "[적용 경로]",
    `위험 경로=${state.route}; 회차 상한=${state.requirements.max_rounds}; 해석자=${state.requirements.interpreters}; 판정자=${state.requirements.judges}`,
    `축소 재검사=${state.features.reduced_recheck ? "켬" : "끔"}; 대화 정책 실험=${state.features.dialogue_policy ? "켬" : "끔"}`,
  ].join("\n");
}

const target = stateArgument(process.argv.slice(2));
process.stdout.write(`${render(readState(target))}\n`);

export { readState, render };
