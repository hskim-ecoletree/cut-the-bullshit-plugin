#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { classifyPost, postToolEvent, preToolEvent } from "../scripts/tool-events.mjs";
import { isExemptMessage } from "../core/message-policy.mjs";
import { collectChecklists } from "../core/checklists.mjs";

const REQUIRED = Object.freeze({ interpreters: 2, judges: 3, critiques: 1, max_rounds: 2 });
const STANDARD = Object.freeze({ interpreters: 1, judges: 2, critiques: 1, max_rounds: 1 });
const BLOCK_REASON = "출력 준비를 마친 뒤 최종 답변을 다시 제출하세요.";
const STATE_FAILURE_CONTEXT = "검사 상태를 준비하지 못했다. 이 턴에는 추가 검사를 실행하지 않는다.";
const LOCK_WAIT_MS = 1000;
const STALE_LOCK_MS = 30000;
const DEFAULT_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function enabled(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null) return defaultValue;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function duration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function normalizedMessage(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function messageHash(value) {
  const text = normalizedMessage(value);
  return text ? crypto.createHash("sha256").update(text).digest("hex") : null;
}

function inputJson() {
  try { return JSON.parse(fs.readFileSync(0, "utf8")); } catch { return {}; }
}

function dataRoot() {
  return process.env.PLUGIN_DATA || path.join(process.cwd(), ".cut-the-bullshit-codex-data");
}

function pluginRoot() {
  return process.env.PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function hashId(value) {
  return value == null || value === "" ? null : `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

// Explicit opt-in probe output for bounded dogfooding. It records only schema
// names, categorical values, counts, and one-way identifiers—never prompt,
// assistant, tool input/output, or transcript bodies.
function probe(input, extra = {}) {
  const target = process.env.CTB_CODEX_PROBE_FILE;
  if (!target || !path.isAbsolute(target)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) return;
    const toolInputText = input.tool_input && typeof input.tool_input === "object"
      ? [input.tool_input.command, input.tool_input.cmd, input.tool_input.message, input.tool_input.prompt, input.tool_input.task]
        .find((value) => typeof value === "string") ?? ""
      : "";
    const record = {
      observedAt: Date.now(),
      event: String(input.hook_event_name ?? "unknown"),
      keys: Object.keys(input).sort(),
      turnId: hashId(input.turn_id),
      agentId: hashId(input.agent_id ?? input.thread_id ?? input.subagent_id),
      agentType: String(input.agent_type ?? input.subagent_type ?? input.agent_name ?? "") || null,
      toolCategory: input.tool_name == null ? null : String(input.tool_name).toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 80),
      toolInputKeys: input.tool_input && typeof input.tool_input === "object" ? Object.keys(input.tool_input).sort() : [],
      toolInputTextChars: toolInputText.length,
      toolInputProbeMarkerVisible: toolInputText.includes("CTB_HOST_PROBE_MARKER_7F3A"),
      requestedAgentType: input.tool_input && typeof input.tool_input === "object"
        ? String(input.tool_input.agent_type ?? input.tool_input.subagent_type ?? input.tool_input.agent_name ?? input.tool_input.task_name ?? "") || null
        : null,
      stopHookActive: input.stop_hook_active === true,
      assistantChars: typeof input.last_assistant_message === "string" ? input.last_assistant_message.length : null,
      ...extra,
    };
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {}
}

function statePath(turnId) {
  const key = crypto.createHash("sha256").update(String(turnId)).digest("hex");
  return path.join(dataRoot(), "turns", `${key}.json`);
}

function activeTurnPath(sessionId) {
  const key = crypto.createHash("sha256").update(String(sessionId)).digest("hex");
  return path.join(dataRoot(), "sessions", `${key}.json`);
}

function cleanupDirectory(dir, ttlMs) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
      if (entry.isFile() && /^(?:[a-f0-9]{64}\.json|[a-f0-9]{64}\.json\.\d+\.tmp)$/.test(entry.name)) fs.rmSync(target, { force: true });
      else if (entry.isDirectory() && /\.json\.lock(?:\.stale\..+)?$/.test(entry.name)) fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }
}

function cleanupExpired() {
  cleanupDirectory(path.join(dataRoot(), "turns"), duration("CTB_TURN_TTL_MS", DEFAULT_TURN_TTL_MS));
  cleanupDirectory(path.join(dataRoot(), "sessions"), duration("CTB_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS));
}

function rememberActiveTurn(sessionId, turnId) {
  if (!sessionId) return;
  const target = activeTurnPath(sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const now = Date.now();
  fs.writeFileSync(temporary, `${JSON.stringify({
    turn_id: String(turnId),
    updated_at: now,
    expires_at: now + duration("CTB_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS),
  })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function activeTurn(sessionId) {
  if (!sessionId) return null;
  try {
    const value = JSON.parse(fs.readFileSync(activeTurnPath(sessionId), "utf8"));
    if (Number.isFinite(value.expires_at) && value.expires_at <= Date.now()) return null;
    return typeof value.turn_id === "string" && value.turn_id ? value.turn_id : null;
  } catch { return null; }
}

function requestKind(prompt) {
  const raw = String(prompt ?? "");
  const marked = /\[원 요청\]\s*\n([\s\S]*?)(?=\n\s*\[[^\n]+\]\s*\n|$)/.exec(raw)?.[1];
  const text = String(marked ?? raw).toLowerCase();
  if (/(구현|수정|고쳐|바꿔|추가|삭제|만들|빌드|배포|실행|테스트|implement|fix|change|build|create|delete|deploy|run\b|test\b)/i.test(text)) return "execution";
  if (/(검토|리뷰|감사|진단|원인|review|audit|diagnos)/i.test(text)) return "review";
  if (/(결정|선택|추천|해야|정책|decide|choose|recommend|should)/i.test(text)) return "decision";
  if (/(무엇|언제|어디|누가|사실|what|when|where|who|fact)/i.test(text)) return "fact";
  if (/(왜|어떻게|설명|의미|why|how|explain|mean)/i.test(text)) return "explanation";
  return "conversation";
}

function featureSettings() {
  return {
    strict_output_link: enabled("CTB_STRICT_OUTPUT_LINK", true),
    experiment_observe_only: enabled("CTB_EXPERIMENT_OBSERVE_ONLY"),
    risk_routing: enabled("CTB_RISK_ROUTING"),
    reduced_recheck: enabled("CTB_REDUCED_RECHECK"),
    dialogue_policy: enabled("CTB_DIALOGUE_POLICY_EXPERIMENT"),
  };
}

function routeFor(kind, features) {
  if (!features.risk_routing) return "legacy";
  return kind === "execution" || kind === "review" || kind === "decision" ? "high" : "standard";
}

function emptyState(turnId, prompt = "", requirements = REQUIRED, features = featureSettings()) {
  const now = Date.now();
  const kind = requestKind(prompt);
  const route = routeFor(kind, features);
  return {
    version: 2,
    turn_id: String(turnId),
    created_at: now,
    updated_at: now,
    expires_at: now + duration("CTB_TURN_TTL_MS", DEFAULT_TURN_TTL_MS),
    prompt_received: false,
    stop_blocks: 0,
    released: false,
    checklist_available: true,
    request: { kind },
    route,
    features,
    requirements: { ...(route === "standard" ? STANDARD : requirements) },
    event_sequence: 0,
    agents: [],
    coordination: [],
    tools: [],
    tallies: [],
  };
}

function withTurnLock(turnId, callback) {
  const lock = `${statePath(turnId)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs >= STALE_LOCK_MS) {
          const stale = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`;
          fs.renameSync(lock, stale);
          fs.rmSync(stale, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return callback(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function load(turnId) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(turnId), "utf8"));
    if (value?.version !== 2 || value?.turn_id !== String(turnId)) return emptyState(turnId);
    if (Number.isFinite(value.expires_at) && value.expires_at <= Date.now()) return emptyState(turnId);
    return value;
  } catch { return emptyState(turnId); }
}

function save(state) {
  const target = statePath(state.turn_id);
  state.updated_at = Date.now();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function checklistContext(cwd) {
  const collected = collectChecklists({ pluginRoot: pluginRoot(), cwd, defaults: REQUIRED });
  if (!collected.available) return { available: false, requirements: { ...REQUIRED }, context: "기본 체크리스트를 읽지 못했다. 이 턴에는 추가 검사를 실행하지 않는다." };
  return { available: true, requirements: collected.requirements, overrides: collected.overrides, context: [
    "최종 답변이 짧거나 코드 중심이 아니면 cut-the-bullshit 스킬을 실행한다.",
    "검사 과정과 내부 역할 이름을 사용자 화면에 쓰지 말고, 고쳐 쓴 답변 하나만 최종 제출한다.",
    "한 회차의 해석자·판정자 수와 회차 상한은 아래 적용 경로 지시를 따른다.",
    "<<<체크리스트 시작>>>",
    ...collected.parts.flatMap(({ label, text }) => [`## ${label}`, text]),
    "<<<체크리스트 끝>>>",
  ].join("\n\n") };
}

function runtimeContext(state) {
  const reviewScript = path.join(pluginRoot(), "scripts", "review-context.mjs");
  const lines = [
    "평가자를 시작하기 직전에 아래 명령을 실행하고, 출력의 호스트 도구 근거와 작은 대화 상태를 평가자 지적 및 고쳐쓰기에 그대로 전달한다.",
    `node ${JSON.stringify(reviewScript)} --state ${JSON.stringify(statePath(state.turn_id))}`,
    "호스트 결과 조각을 자기 요약으로 바꾸지 않는다. 작은 대화 상태의 빈 배열은 실제 대화에서 확인한 내용만 채우고 사용자의 전문성을 추측하지 않는다.",
    `현재 요청 성격은 ${state.request.kind}, 적용 경로는 ${state.route}이다. 이 턴은 해석자 ${state.requirements.interpreters}개, 판정자 ${state.requirements.judges}개, 회차 상한 ${state.requirements.max_rounds}을 적용한다.`,
    "각 역할의 응답 본문이 SubagentStop에 기록되어야 하며, 평가 대상과 평가 결과 또는 재작성 결과가 최종 답과 연결되지 않으면 Stop이 답을 허용하지 않는다.",
  ];
  if (state.features.reduced_recheck) {
    lines.push("두 번째 회차는 바뀐 주장, 앞 회차에서 걸린 항목, 의미 보존만 재검사한다. 각 해석자·판정자 입력에 `[검사 범위]\n축소`, `[이전 tally]`, `[이전 critique]`, `[바뀐 문장 또는 명제]`, `[원 요청의 의미 보존 조건]`과 각 본문을 넣는다.");
  }
  if (state.features.dialogue_policy) {
    lines.push("대화 정책 실험이 켜졌다. 완료 보고는 표가 아니어도 결론·한 일·남은 문제의 순서가 분명하면 허용하고, 이미 합의한 대화 맥락을 불필요하게 되풀이하지 않는다. 형식-6~9는 정보 없는 표현이라는 한 묶음으로 지적하되 원래 항목 ID는 보존한다.");
  }
  return lines.join("\n\n");
}

function roleOf(input) {
  const type = String(input.agent_type ?? input.subagent_type ?? input.agent_name ?? input.task_name ?? "").toLowerCase().replaceAll("-", "_");
  if (type.includes("ctb_interpreter")) return "interpreter";
  if (type.includes("ctb_judge")) return "judge";
  if (type.includes("ctb_evaluator_critique")) return "critique";
  if (type.includes("ctb_evaluator_rewrite")) return "rewrite";
  return null;
}

function agentOutput(input) {
  for (const value of [input.last_assistant_message, input.assistant_message, input.output, input.result?.text, input.result?.output]) {
    if (typeof value === "string" && value.trim()) return normalizedMessage(value);
  }
  return null;
}

function critiqueStatus(text) {
  const first = String(text ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";
  if (first === "통과") return "pass";
  if (first === "지적 있음") return "issues";
  return "unknown";
}

function spawnMessage(toolInput) {
  for (const value of [toolInput?.message, toolInput?.prompt, toolInput?.task]) {
    if (typeof value === "string") return value;
  }
  return "";
}

function markedDraft(text) {
  const match = /<<<초안 시작>>>\s*\n([\s\S]*?)\n<<<초안 끝>>>/.exec(text);
  return match ? messageHash(match[1]) : null;
}

function reviewScope(text) {
  const match = /\[검사 범위\]\s*\n\s*(전체|축소)(?:\s|$)/.exec(text);
  return match?.[1] === "축소" ? "reduced" : "full";
}

const REDUCED_CONTEXT_LABELS = Object.freeze([
  "이전 tally",
  "이전 critique",
  "바뀐 문장 또는 명제",
  "원 요청의 의미 보존 조건",
]);

function sectionBody(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\[${escaped}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[[^\\n]+\\](?:\\s*\\n|$)|$)`).exec(text);
  return match?.[1]?.trim() ?? "";
}

function reducedContextComplete(text) {
  return REDUCED_CONTEXT_LABELS.every((label) => sectionBody(text, label));
}

function reducedContextHashes(text) {
  return Object.fromEntries(REDUCED_CONTEXT_LABELS.map((label) => [label, messageHash(sectionBody(text, label))]));
}

function reviewOperation(input) {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command :
    typeof input.tool_input?.cmd === "string" ? input.tool_input.cmd : "";
  if (/(?:^|[/\\])tally\.mjs(?:["']?\s|$)/.test(command) || command.trim() === "tally") return "tally";
  if (/(?:^|[/\\])review-context\.mjs(?:["']?\s|$)/.test(command)) return "review-context";
  return null;
}

function internalReviewCommand(input) {
  return reviewOperation(input) !== null;
}

function recordAgent(state, input, phase) {
  const role = roleOf(input);
  const agentId = String(input.agent_id ?? input.thread_id ?? input.subagent_id ?? "");
  if (!agentId) return;
  state.event_sequence = (state.event_sequence ?? 0) + 1;
  if (!role && phase === "stopped") {
    const found = state.agents.find((x) => x.agent_id === agentId);
    if (found) {
      found.stopped = true;
      found.stopped_sequence = state.event_sequence;
      const output = agentOutput(input);
      if (output) {
        found.output_hash = messageHash(output);
        if (found.role === "critique") found.critique_status = critiqueStatus(output);
      }
    }
    return;
  }
  if (!role) return;
  const found = state.agents.find((x) => x.agent_id === agentId && x.role === role);
  if (found) {
    found[phase] = true;
    found[`${phase}_sequence`] = state.event_sequence;
    if (phase === "stopped") {
      const output = agentOutput(input);
      if (output) {
        found.output_hash = messageHash(output);
        if (role === "critique") found.critique_status = critiqueStatus(output);
      }
    }
  }
  else state.agents.push({
    agent_id: agentId,
    role,
    started: phase === "started",
    stopped: phase === "stopped",
    ...(phase === "stopped" && agentOutput(input) ? {
      output_hash: messageHash(agentOutput(input)),
      ...(role === "critique" ? { critique_status: critiqueStatus(agentOutput(input)) } : {}),
    } : {}),
    ...(phase === "started" ? { started_sequence: state.event_sequence } : { stopped_sequence: state.event_sequence }),
  });
}

function completeAgents(state, role) {
  return state.agents.filter((x) => x.role === role && x.started && x.stopped);
}

function validRound(state) {
  const required = state.requirements ?? REQUIRED;
  const complete = state.agents.filter((x) => x.started && x.stopped);
  const boundaries = complete.filter((x) => x.role === "rewrite").map((x) => x.stopped_sequence).sort((a, b) => a - b);
  const rounds = [];
  let after = 0;
  for (const through of boundaries) {
    rounds.push({ after, through, agents: complete.filter((x) => x.started_sequence > after && x.stopped_sequence <= through) });
    after = through;
  }
  const trailing = complete.filter((x) => x.started_sequence > after);
  if (trailing.length > 0 || rounds.length === 0) {
    rounds.push({ after, through: Number.POSITIVE_INFINITY, agents: trailing });
  }
  if (rounds.length === 0 || rounds.length > required.max_rounds) return false;
  const allIds = new Set(complete.map((x) => x.agent_id));
  if (allIds.size !== complete.length) return false;
  return rounds.every(({ agents: round, after: roundAfter, through: roundThrough }) => {
    const interpreters = round.filter((x) => x.role === "interpreter");
    const judges = round.filter((x) => x.role === "judge");
    const critiques = round.filter((x) => x.role === "critique");
    const rewrites = round.filter((x) => x.role === "rewrite");
    const wave = [...interpreters, ...judges];
    if (interpreters.length !== required.interpreters || judges.length !== required.judges ||
        critiques.length !== required.critiques || rewrites.length > 1) return false;

    // Codex does not expose a launch-wave identifier. The observable barrier is
    // equivalent for this workflow: all five starts must be recorded before any
    // one of the five stops. A serial start/stop sequence therefore cannot pass.
    const lastWaveStart = Math.max(...wave.map((x) => x.started_sequence));
    const firstWaveStop = Math.min(...wave.map((x) => x.stopped_sequence));
    const coordination = (state.coordination ?? []).filter((x) => x.sequence > roundAfter && x.sequence <= roundThrough);
    const spawn = coordination.filter((x) => x.kind === "spawn");
    const waveSpawn = spawn.filter((x) => x.role === "interpreter" || x.role === "judge");
    if (waveSpawn.length > 0) {
      const spawnCounts = {
        interpreter: waveSpawn.filter((x) => x.role === "interpreter").length,
        judge: waveSpawn.filter((x) => x.role === "judge").length,
      };
      if (spawnCounts.interpreter !== required.interpreters || spawnCounts.judge !== required.judges) return false;
      // A wait response for the preceding rewrite can arrive after its
      // SubagentStop hook and therefore fall just inside the next round's
      // sequence window. Only a wait after this round's first spawn is a
      // launch-wave barrier for this round.
      const firstSpawn = Math.min(...waveSpawn.map((x) => x.sequence));
      const firstWait = coordination.find((x) => x.kind === "wait" && x.sequence > firstSpawn);
      if (!firstWait || Math.max(...waveSpawn.map((x) => x.sequence)) >= firstWait.sequence) return false;
    } else if (lastWaveStart >= firstWaveStop) return false;

    const lastWaveStop = Math.max(...wave.map((x) => x.stopped_sequence));
    if (critiques.some((x) => x.started_sequence <= lastWaveStop)) return false;
    const lastCritiqueStop = Math.max(...critiques.map((x) => x.stopped_sequence));
    if (rewrites.some((x) => x.started_sequence <= lastCritiqueStop)) return false;
    return true;
  });
}

function linkedOutput(state, finalMessage) {
  if (!state.features?.strict_output_link) return true;
  const required = state.requirements ?? REQUIRED;
  const complete = state.agents.filter((x) => x.started && x.stopped);
  const boundaries = complete.filter((x) => x.role === "rewrite").map((x) => x.stopped_sequence).sort((a, b) => a - b);
  const rounds = [];
  let after = 0;
  for (const through of boundaries) {
    rounds.push({ after, through, agents: complete.filter((x) => x.started_sequence > after && x.stopped_sequence <= through) });
    after = through;
  }
  const trailing = complete.filter((x) => x.started_sequence > after);
  if (trailing.length > 0) rounds.push({ after, through: Number.POSITIVE_INFINITY, agents: trailing });
  if (rounds.length === 0) return false;

  let priorCandidate = null;
  let lastStatus = null;
  for (let index = 0; index < rounds.length; index += 1) {
    const { after: roundAfter, through: roundThrough, agents } = rounds[index];
    const wave = agents.filter((x) => x.role === "interpreter" || x.role === "judge");
    const critique = agents.find((x) => x.role === "critique");
    const rewrite = agents.find((x) => x.role === "rewrite");
    if (!critique?.output_hash || !["pass", "issues"].includes(critique.critique_status)) return false;

    const coordination = (state.coordination ?? []).filter((x) => x.sequence > roundAfter && x.sequence <= roundThrough);
    const waveSpawns = coordination.filter((x) => x.kind === "spawn" && (x.role === "interpreter" || x.role === "judge"));
    if (waveSpawns.length !== wave.length || waveSpawns.some((x) => !x.draft_hash)) return false;
    const draftHashes = new Set(waveSpawns.map((x) => x.draft_hash));
    if (draftHashes.size !== 1) return false;
    const draftHash = [...draftHashes][0];
    if (priorCandidate && priorCandidate !== draftHash) return false;
    if (state.features.reduced_recheck && index > 0 &&
        waveSpawns.some((x) => x.review_scope !== "reduced" || x.reduced_context_complete !== true)) return false;

    const lastJudgeStop = Math.max(...agents.filter((x) => x.role === "judge").map((x) => x.stopped_sequence));
    const tally = (state.tallies ?? []).find((x) => x.sequence > lastJudgeStop && x.sequence < critique.started_sequence);
    if (!tally || tally.judge_count !== required.judges) return false;

    const critiqueSpawn = coordination.find((x) => x.kind === "spawn" && x.role === "critique");
    if (!critiqueSpawn || critiqueSpawn.draft_hash !== draftHash) return false;
    lastStatus = critique.critique_status;
    if (lastStatus === "pass") {
      if (rewrite) return false;
      priorCandidate = draftHash;
    } else {
      const rewriteSpawn = coordination.find((x) => x.kind === "spawn" && x.role === "rewrite");
      if (!rewrite?.output_hash || !rewriteSpawn || rewriteSpawn.draft_hash !== draftHash) return false;
      priorCandidate = rewrite.output_hash;
    }
  }

  if (lastStatus === "issues" && rounds.length < required.max_rounds) return false;
  return messageHash(finalMessage) === priorCandidate;
}

function outputContext(context) {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
}

function writeJson(value) {
  try { fs.writeFileSync(1, `${JSON.stringify(value)}\n`); } catch {}
}

function main(input) {
  const event = input.hook_event_name;
  const turnId = input.turn_id;
  if (!turnId || typeof turnId !== "string") return;

  probe(input, { phase: "received" });

  if (event === "UserPromptSubmit") {
    cleanupExpired();
    const bundle = checklistContext(input.cwd);
    const features = featureSettings();
    const state = emptyState(turnId, input.prompt ?? input.user_prompt ?? "", bundle.requirements ?? REQUIRED, features);
    state.settings_overrides = bundle.overrides ?? {};
    Object.assign(state.requirements, state.settings_overrides);
    state.prompt_received = true;
    state.checklist_available = bundle.available;
    if (process.env.CTB_NEGATIVE_STOP_PROBE === "1") {
      bundle.context = [
        "비식별 Stop 음성 대조다. 첫 응답에서는 도구와 subagent를 쓰지 말고 사용자가 요구한 긴 답을 즉시 제출한다. Stop이 이를 막은 뒤에만 다음 작업을 판단한다.",
        bundle.context,
      ].join("\n\n");
    }
    withTurnLock(turnId, () => {
      save(state);
      rememberActiveTurn(input.session_id, turnId);
    });
    writeJson(outputContext([bundle.context, runtimeContext(state)].join("\n\n")));
    probe(input, { phase: "completed", checklistAvailable: bundle.available });
    return;
  }

  const correlatedTurnId = event === "Stop" ? turnId : (activeTurn(input.session_id) ?? turnId);
  let output = null;
  withTurnLock(correlatedTurnId, () => {
    const state = load(correlatedTurnId);
    if (event === "SubagentStart") recordAgent(state, input, "started");
    else if (event === "SubagentStop") recordAgent(state, input, "stopped");
    else if (event === "PreToolUse" && input.tool_use_id) {
      state.event_sequence = (state.event_sequence ?? 0) + 1;
      const tool = preToolEvent(input);
      const operation = reviewOperation(input);
      if (operation) {
        tool.internal_review = true;
        tool.review_operation = operation;
      }
      state.tools.push(tool);
      if (state.features?.risk_routing && !state.features?.experiment_observe_only && !internalReviewCommand(input) && ["shell", "write", "network"].includes(tool.category)) {
        state.route = "high";
        state.requirements = { ...REQUIRED, ...(state.settings_overrides ?? {}) };
      }
    }
    else if (event === "PostToolUse" && input.tool_use_id) {
      state.event_sequence = (state.event_sequence ?? 0) + 1;
      const index = state.tools.findLastIndex((x) => x.tool_use_id === String(input.tool_use_id));
      const prior = index >= 0 ? state.tools[index] : null;
      const next = postToolEvent(input, prior);
      if (prior?.internal_review) {
        next.internal_review = true;
        next.review_operation = prior.review_operation;
      }
      if (index >= 0) state.tools[index] = next;
      else state.tools.push(next);
      if (state.tools.length > 100) {
        state.tools.splice(0, state.tools.length - 100);
        state.evidence_window = "last_100_events";
      }
      const name = String(input.tool_name ?? "").toLowerCase().replaceAll("_", "");
      if (name.includes("spawnagent") && next.outcome === "success") {
        const role = roleOf(input.tool_input ?? {});
        if (role) {
          const message = spawnMessage(input.tool_input);
          state.coordination.push({
            kind: "spawn",
            role,
            sequence: state.event_sequence,
            draft_hash: markedDraft(message),
            review_scope: reviewScope(message),
            reduced_context_complete: reducedContextComplete(message),
            reduced_context_hashes: reducedContextHashes(message),
          });
        }
      } else if (name.includes("waitagent")) state.coordination.push({ kind: "wait", sequence: state.event_sequence });
      const tallyMatch = next.evidence?.excerpt?.match(/판정자\s+(\d+)명\./);
      if (tallyMatch && next.outcome === "success" && next.review_operation === "tally") {
        state.tallies.push({ sequence: state.event_sequence, judge_count: Number(tallyMatch[1]), output_hash: next.evidence.result_sha256 });
      }
    } else if (event === "Stop") {
      const message = String(input.last_assistant_message ?? input.assistant_message ?? "");
      if (state.features?.experiment_observe_only || state.checklist_available === false || isExemptMessage(message) || (validRound(state) && linkedOutput(state, message))) state.released = true;
      else {
        state.stop_blocks += 1;
        output = { decision: "block", reason: BLOCK_REASON };
      }
    } else return;
    save(state);
  });
  if (event === "Stop") probe(input, { phase: "completed", decision: output ? "block" : "allow" });
  if (output) writeJson(output);
}

const input = inputJson();
try {
  main(input);
} catch {
  probe(input, { phase: "failed", failureCategory: "hook-infrastructure" });
  if (input.hook_event_name === "UserPromptSubmit") writeJson(outputContext(STATE_FAILURE_CONTEXT));
}

export { classifyPost, validRound };
