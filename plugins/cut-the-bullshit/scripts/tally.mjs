#!/usr/bin/env node
// 판정자들이 낸 `요약:` 줄을 모아 항목마다 다수결을 낸다.

import fs from "node:fs";

const GLITCH = "걸림";
const PASS = "통과";
const NA = "해당 없음";

function normalize(verdict) {
  const v = verdict.replace(/\s+/g, "");
  if (v === "걸림") return GLITCH;
  if (v === "통과") return PASS;
  if (v === "해당없음" || v === "없음") return NA;
  return v;
}

function parseSummary(line) {
  if (!/^\s*요약\s*:/.test(line)) {
    throw new Error("판정자 요약은 `요약:`으로 시작해야 한다.");
  }
  const body = line.replace(/^\s*요약\s*:\s*/, "");
  const out = new Map();
  for (const pair of body.split(",")) {
    const at = pair.indexOf("=");
    if (at < 0) throw new Error(`항목=판정 형식이 아니다: ${pair.trim() || "(빈 항목)"}`);
    const id = pair.slice(0, at).trim();
    const verdict = pair.slice(at + 1).trim();
    if (!id || !verdict) throw new Error(`항목 또는 판정이 비었다: ${pair.trim() || "(빈 항목)"}`);
    if (out.has(id)) throw new Error(`같은 항목이 두 번 나왔다: ${id}`);
    const normalized = normalize(verdict);
    if (![GLITCH, PASS, NA].includes(normalized)) throw new Error(`읽을 수 없는 판정이다: ${id}=${verdict}`);
    out.set(id, normalized);
  }
  return out;
}

function readInputs(argv) {
  if (argv.length > 0) return argv;
  const raw = fs.readFileSync(0, "utf8");
  return raw.split("\n").filter((line) => /^\s*요약\s*:/.test(line));
}

function tally(summaries) {
  const order = [];
  const seen = new Set();
  for (const summary of summaries) {
    for (const id of summary.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }

  return order.map((id) => {
    const votes = summaries.map((summary) => summary.get(id)).filter(Boolean);
    const missing = summaries.length - votes.length;
    const counts = new Map();
    for (const verdict of votes) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);

    let top = null;
    let topCount = 0;
    let tied = false;
    for (const [verdict, count] of counts) {
      if (count > topCount) {
        top = verdict;
        topCount = count;
        tied = false;
      } else if (count === topCount) {
        tied = true;
      }
    }

    return {
      id,
      decided: tied ? GLITCH : top,
      unanimous: !tied && topCount === votes.length && missing === 0,
      tied,
      missing,
      split: [...counts.entries()].map(([verdict, count]) => `${verdict} ${count}`).join(" 대 "),
      anyGlitch: (counts.get(GLITCH) ?? 0) > 0,
    };
  });
}

function render(rows, judgeCount) {
  const lines = [`판정자 ${judgeCount}명. 항목 ${rows.length}개.`, ""];
  const carry = rows.filter((row) => row.decided === GLITCH || row.anyGlitch);
  const quiet = rows.filter((row) => !(row.decided === GLITCH || row.anyGlitch));

  if (carry.length === 0) {
    lines.push("걸림을 낸 판정자가 하나도 없다.");
  } else {
    lines.push("| 항목 | 확정 판정 | 갈림 |");
    lines.push("| --- | --- | --- |");
    for (const row of carry) {
      const note = row.unanimous
        ? "만장일치"
        : row.tied
          ? `다수 없음(${row.split}) — 걸림으로 둔다`
          : row.split;
      const miss = row.missing > 0 ? ` · 판정자 ${row.missing}명이 이 항목을 안 냈다` : "";
      lines.push(`| ${row.id} | ${row.decided} | ${note}${miss} |`);
    }
  }

  if (quiet.length > 0) {
    lines.push("");
    lines.push(`걸림 없음 — ${quiet.map((row) => row.id).join(", ")}`);
  }

  const unknown = rows.filter((row) => ![GLITCH, PASS, NA].includes(row.decided));
  if (unknown.length > 0) {
    lines.push("");
    lines.push(`읽지 못한 판정이 있다 — ${unknown.map((row) => `${row.id}=${row.decided}`).join(", ")}. 판정자 답을 직접 봐라.`);
  }

  return lines.join("\n");
}

const inputs = readInputs(process.argv.slice(2));
if (inputs.length === 0) {
  process.stderr.write("판정자의 `요약:` 줄을 인자로 넘겨라. 하나도 못 받았다.\n");
  process.exit(1);
}

let summaries;
try {
  summaries = inputs.map(parseSummary);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const empty = summaries.filter((summary) => summary.size === 0).length;
if (empty > 0) {
  process.stderr.write(`요약 줄에서 항목을 하나도 못 읽은 것이 ${empty}개다.\n`);
  process.exit(1);
}

const expectedIds = [...summaries[0].keys()];
for (let index = 1; index < summaries.length; index += 1) {
  const ids = [...summaries[index].keys()];
  if (ids.length !== expectedIds.length || ids.some((id, at) => id !== expectedIds[at])) {
    process.stderr.write(`판정자 ${index + 1}의 항목 목록이나 순서가 다른 판정자와 다르다.\n`);
    process.exit(1);
  }
}

process.stdout.write(`${render(tally(summaries), summaries.length)}\n`);
