import fs from "node:fs";
import path from "node:path";

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function numericSettings(text) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(String(text ?? ""))?.[1] ?? "";
  const out = {};
  const names = new Map([
    ["해석자 수", "interpreters"], ["interpreter_count", "interpreters"],
    ["판정자 수", "judges"], ["judge_count", "judges"],
    ["회차 상한", "max_rounds"], ["max_rounds", "max_rounds"],
  ]);
  for (const line of frontmatter.split("\n")) {
    const match = /^\s*([^:#]+?)\s*:\s*(\d+)\s*$/.exec(line);
    const key = match && names.get(match[1].trim());
    if (key && Number(match[2]) > 0 && Number(match[2]) <= 20) out[key] = Number(match[2]);
  }
  return out;
}

export function collectChecklists({ pluginRoot, cwd, defaults = {} }) {
  const dir = path.join(pluginRoot, "checklists");
  const base = readText(path.join(dir, "base.md"));
  if (base === null) return { available: false, parts: [], requirements: { ...defaults }, overrides: {} };

  const parts = [{ label: "기본", where: "checklists/base.md", text: base }];
  const requirements = { ...defaults, ...numericSettings(base) };
  const overrides = {};
  let languages = [];
  try { languages = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "base.md").sort(); } catch {}
  for (const name of languages) {
    const text = readText(path.join(dir, name));
    if (text !== null) parts.push({ label: `언어 규칙 — ${name.slice(0, -3)}`, where: `checklists/${name}`, text });
  }

  const userRoot = process.env.HOME || process.env.USERPROFILE;
  if (userRoot) {
    const text = readText(path.join(userRoot, ".cut-the-bullshit", "checklist.md"));
    if (text !== null) {
      parts.push({ label: "전역", where: "~/.cut-the-bullshit/checklist.md", text });
      Object.assign(overrides, numericSettings(text));
      Object.assign(requirements, numericSettings(text));
    }
  }

  const projectRoot = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const project = readText(path.join(projectRoot, ".cut-the-bullshit", "checklist.md"));
  if (project !== null) {
    parts.push({ label: "프로젝트", where: "<저장소 루트>/.cut-the-bullshit/checklist.md", text: project });
    Object.assign(overrides, numericSettings(project));
    Object.assign(requirements, numericSettings(project));
  }
  return { available: true, parts, requirements, overrides };
}
