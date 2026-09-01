#!/usr/bin/env node
// cut-the-bullshit 관문.
//
// 두 이벤트를 한 파일이 맡는다. 들어온 JSON의 hook_event_name으로 가른다.
//
//   UserPromptSubmit — 턴 앞머리에 지시 한 벌과 합친 체크리스트를 문맥으로 넣는다. 막지 않는다.
//   Stop            — 검사를 안 밟은 최종 메시지를 막는다. exit 2 + stderr.
//
// 체크리스트를 여기서 넣는 이유는 시간이다. 2026-08-26 측정에서 2회차를 완주한 판의
// 절반 남짓이 조율이었고(48~54%), 그중 원 에이전트가 파일 넷을 읽고 판정자 셋에게
// 전문을 옮겨 쓰는 몫이 있었다. 그 전문은 매번 같다. 프로그램이 한 번 읽어 넣으면
// 원 에이전트가 읽을 것도 옮겨 쓸 것도 없다. 판정 결과는 하나도 안 바뀐다.
//
// Stop을 모델(type: "prompt")이 아니라 이 스크립트가 맡는 이유가 셋이다.
//   1. "이번 턴에 스킬이 돌았는가"는 prompt 훅이 답할 수 없다. 입력 JSON에 그 필드가 없고
//      prompt 훅을 도는 모델에는 도구가 없다. 그래서 늘 거짓으로 평가되어 긴 답마다
//      오판했고, 답이 두 번 나갔다. 여기서는 transcript를 직접 읽어 답한다.
//   2. prompt 훅이 막으면 호스트가 프롬프트 본문을 통째로 화면에 실어 보낸다.
//      command 훅의 stderr는 우리가 쓴 문장 하나뿐이다.
//   3. 판정에 모델이 끼지 않으므로 같은 메시지에 같은 판정이 나온다.
//
// 면제 판정 가운데 "계획인가", "진행 보고인가"는 뺐다. 프로그램이 못 재는 것이다.
// 남긴 것은 세는 것뿐이다 — 문장 수, 글자 수, 코드가 차지하는 줄 비율.
//
// 스킬을 부른 것만으로는 검사가 돌았다고 볼 수 없다. 2026-08-26 측정에서 여섯 판 중
// 한 판이 2회차에 해석자와 판정자를 건너뛰고 고쳐쓰기만 불러, 고쳐 쓴 문장이 아무
// 판정도 안 받고 나갔다. 그래서 스킬이 돌았으면 회차 구조까지 센다 — 회차마다
// 해석자·판정자·평가자 지적이 하나씩은 있어야 한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExemptMessage } from "../plugins/cut-the-bullshit/core/message-policy.mjs";
import { collectChecklists } from "../plugins/cut-the-bullshit/core/checklists.mjs";

const STANDING = [
  "이번 턴의 최종 답변을 사용자에게 내기 전에 cut-the-bullshit:cut-the-bullshit 스킬을 실행한다.",
  "검사를 마치고 다시 쓴 것을 최종 답변으로 낸다. 검사했다는 사실을 사용자에게 알리지 않는다.",
  "다음은 검사하지 않고 그대로 낸다 —",
  "세 문장 이하이면서 400자 이하인 짧은 확인이나 되묻기,",
  "본문의 절반 이상이 코드 블록이나 diff나 명령어 출력인 메시지,",
  "도구를 쓰는 중에 나가는 진행 상태 보고, 계획을 내놓는 메시지.",
  "뒤의 둘은 관문이 재지 못한다. 네가 건너뛰어도 관문이 막을 수 있고, 그때는 검사한다.",
].join("\n");

// 체크리스트를 붙일 때 앞에 두는 말. 스킬 0절이 하던 일을 이 자리가 대신한다.
const CHECKLIST_HEAD = [
  "",
  "검사에 쓸 체크리스트를 아래에 합쳐 두었다. **체크리스트 파일을 다시 읽지 마라.**",
  "판정자에게 넘길 때는 <<<체크리스트 시작>>>과 <<<체크리스트 끝>>> 사이의 것을 쓴다.",
  "앞머리의 회차 상한·해석자 수·판정자 수가 이번 판의 설정이다.",
  "",
].join("\n");

// 기본 체크리스트를 못 읽었을 때. 스킬 0절이 "검사를 접는다"고 정해 둔 자리다.
const CHECKLIST_FAIL = [
  "",
  "**기본 체크리스트를 읽지 못했다. 이번 턴은 검사를 접고 초안을 그대로 낸다.**",
  "해석자도 판정자도 평가자도 부르지 마라. 사용자에게 알리지도 마라.",
].join("\n");

const REASON =
  "cut-the-bullshit:cut-the-bullshit 스킬을 실행하고 그 결과를 최종 메시지로 낸다.";

const ROUND_REASON =
  "cut-the-bullshit 검사의 회차 구조가 어긋났다. 빠진 것을 채워 다시 검사하고 그 결과를 최종 메시지로 낸다 — ";

// 서브에이전트 이름의 꼬리로 역할을 가른다. 호스트가 앞에 플러그인 이름을 붙인다.
const ROLE_MARKS = [
  ["ctb-interpreter", "interpreter"],
  ["ctb-judge", "judge"],
  ["ctb-evaluator", "evaluator"],
];
// 평가자의 두 모드는 프롬프트 첫머리로 가른다. 스킬이 그렇게 쓰라고 정해 둔 계약이다.
const REWRITE_MARK = "모드: 고쳐쓰기";
const CRITIQUE_MARK = "모드: 지적";

const SKILL_MARK = "cut-the-bullshit";
const TAIL_BYTES = 4 * 1024 * 1024;
const INJECTED = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<user-prompt-submit-hook>",
  // Stop 훅이 막으면서 되돌려 보내는 피드백. 이것을 사람이 친 것으로 읽으면
  // 한 번 막힌 뒤에는 검사를 온전히 다시 돌려도 「한 회차도 돌지 않았다」로 세어진다.
  "Stop hook feedback:",
];

function sharedPluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "cut-the-bullshit");
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

// 대화록 꼬리를 읽어 JSON 항목으로 만든다. 못 읽으면 null이다 —
// 빈 배열과 구별해야 한다. 못 읽은 것은 "스킬이 안 돌았다"가 아니다.
function readEntries(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }

  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 잘린 첫 줄은 버린다 */
    }
  }
  return entries;
}

// 이번 턴이 시작하는 자리. 뒤에서부터 훑다가 진짜 사용자 메시지를 만나면 거기다.
function turnStart(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // isMeta는 호스트가 끼워 넣은 것이지 사용자의 턴이 아니다.
    // 스킬을 부르면 바로 뒤에 "Base directory for this skill:"이 isMeta로 붙는다.
    // 이것을 경계로 세면 스킬이 돈 턴마다 안 돈 것으로 읽힌다.
    if (e.isSidechain || e.isMeta) continue;
    const msg = e.message;
    if (!msg) continue;

    if (e.type === "user") {
      const c = msg.content;
      if (Array.isArray(c)) {
        // 도구 결과는 턴 경계가 아니다.
        if (c.some((x) => x && x.type === "tool_result")) continue;
        return i;
      }
      if (typeof c === "string") {
        // 호스트가 주입하는 것들도 user 항목으로 들어온다. 사람이 친 것이 아니므로
        // 턴 경계가 아니다. 2026-08-26 실측에서 <task-notification>을 경계로 읽어
        // 스킬 호출을 못 찾고 매번 막았다.
        if (INJECTED.some((mark) => c.trimStart().startsWith(mark))) continue;
        return i;
      }
      return i;
    }
  }
  return -1; // 사용자 메시지를 못 찾았다. 있는 것을 전부 이번 턴으로 본다
}

// 이번 턴에 부른 것을 순서대로 모은다. 스킬 호출과 서브에이전트 호출 둘 다 본다.
function collectCalls(entries, from) {
  const calls = [];
  for (let i = from + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.isSidechain || e.isMeta) continue;
    if (e.type !== "assistant") continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x || x.type !== "tool_use") continue;
      if (x.name === "Skill" && typeof x.input?.skill === "string" &&
          x.input.skill.includes(SKILL_MARK)) {
        calls.push({ kind: "skill" });
        continue;
      }
      if (x.name !== "Agent" && x.name !== "Task") continue;
      const type = typeof x.input?.subagent_type === "string" ? x.input.subagent_type : "";
      const hit = ROLE_MARKS.find(([mark]) => type.includes(mark));
      if (!hit) continue;
      const prompt = typeof x.input?.prompt === "string" ? x.input.prompt : "";
      calls.push({ kind: hit[1], rewrite: prompt.includes(REWRITE_MARK),
                   critique: prompt.includes(CRITIQUE_MARK) });
    }
  }
  return calls;
}

// 호출 차례를 회차로 자른다. 평가자의 고쳐쓰기가 한 회차의 끝이다.
function splitRounds(calls) {
  const rounds = [];
  let cur = { interpreter: 0, judge: 0, critique: 0 };
  let opened = false;
  for (const c of calls) {
    if (c.kind === "skill") continue;
    opened = true;
    if (c.kind === "interpreter") cur.interpreter += 1;
    else if (c.kind === "judge") cur.judge += 1;
    else if (c.kind === "evaluator") {
      if (c.critique) cur.critique += 1;
      if (c.rewrite) {
        rounds.push(cur);
        cur = { interpreter: 0, judge: 0, critique: 0 };
        opened = false;
      }
    }
  }
  // 마지막 고쳐쓰기 뒤에 남은 것이 있으면 그것도 한 회차다. 평가자가 통과를 내면
  // 고쳐쓰기 없이 끝나므로 이 자리가 빈 것이 정상이다.
  if (opened) rounds.push(cur);
  return rounds;
}

// 앞말의 받침에 따라 주격 조사를 고른다. 2026-08-27에 실물 세션이 「평가자 지적가
// 없다」를 냈다. 이 저장소가 한국어 품질을 다루므로 자기 출력부터 맞춘다.
function subjectParticle(word) {
  const last = word.codePointAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return "가"; // 한글 음절이 아니면 그대로 둔다
  return (last - 0xac00) % 28 === 0 ? "가" : "이";
}

// 회차마다 무엇이 빠졌는지 적는다. 빈 배열이면 온전하다.
function roundGaps(rounds) {
  if (rounds.length === 0) return ["검사 절차를 한 회차도 돌지 않았다"];
  const gaps = [];
  rounds.forEach((r, i) => {
    const lack = [];
    if (!r.interpreter) lack.push("해석자");
    if (!r.judge) lack.push("판정자");
    if (!r.critique) lack.push("평가자 지적");
    if (lack.length) {
      const joined = lack.join("\u00b7");
      gaps.push(`${i + 1}회차에 ${joined}${subjectParticle(joined)} 없다`);
    }
  });
  return gaps;
}

// 기본 체크리스트를 읽을 수 있는가. 못 읽으면 스킬이 검사를 접는 것이 정상이므로
// 회차가 비어도 막지 않는다. 환경 변수가 아니라 이 파일의 자리에서 찾는다.
function checklistReadable() {
  return collectChecklists({ pluginRoot: sharedPluginRoot(), cwd: process.cwd() }).available;
}

// 붙일 체크리스트를 모은다. 기본을 못 읽으면 null이다 — 빈 배열과 구별해야 한다.
// 빈 배열은 나올 수 없고, null은 "검사를 접어라"라는 뜻이다.
//
// 언어 파일은 어느 것을 쓸지 여기서 못 고른다. 턴 앞머리에는 초안이 아직 없어서
// 무슨 언어로 쓸지 모른다. 그래서 있는 것을 다 넣고 고르는 일은 스킬에 남긴다.
function checklistBundle(cwd) {
  const collected = collectChecklists({ pluginRoot: sharedPluginRoot(), cwd });
  return collected.available ? collected.parts.map(({ label, where, text }) => [label, where, text]) : null;
}

// 체크리스트 파일 안에도 `##`과 `###`이 있다. 벌을 가르는 줄은 그것과 안 겹치게
// 따로 표시한다.
function renderChecklists(parts) {
  const out = [CHECKLIST_HEAD, "<<<체크리스트 시작>>>", ""];
  for (const [label, where, text] of parts) {
    out.push(`===== ${label} 체크리스트 · ${where} =====`, "", text.trim(), "");
  }
  out.push("<<<체크리스트 끝>>>");
  return out.join("\n");
}

function main() {
  const input = readStdin();

  if (input.hook_event_name !== "Stop" && input.hook_event_name !== "UserPromptSubmit") {
    return; // 이 스크립트가 맡는 이벤트가 아니다
  }

  if (input.hook_event_name === "UserPromptSubmit") {
    const parts = checklistBundle(input.cwd);
    const context = STANDING + (parts === null ? CHECKLIST_FAIL : renderChecklists(parts));
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      }) + "\n",
    );
    return;
  }

  if (input.stop_hook_active === true) return;

  const msg = typeof input.last_assistant_message === "string"
    ? input.last_assistant_message
    : "";
  if (!msg.trim()) return;

  const entries = readEntries(input.transcript_path);
  const calls = entries ? collectCalls(entries, turnStart(entries)) : [];
  const skillRan = calls.some((c) => c.kind === "skill");

  if (skillRan) {
    // 스킬은 돌았다. 이제 검사가 실제로 밟혔는지 센다.
    if (!checklistReadable()) return;
    const gaps = roundGaps(splitRounds(calls));
    if (gaps.length === 0) return;
    process.stderr.write(ROUND_REASON + gaps.join(". "));
    process.exit(2);
  }

  if (isExemptMessage(msg)) return;

  process.stderr.write(REASON);
  process.exit(2);
}

main();
