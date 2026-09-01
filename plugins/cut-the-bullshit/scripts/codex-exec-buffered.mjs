#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--json")) {
  process.stderr.write("codex-exec-buffered adds --json itself; remove the duplicate flag.\n");
  process.exit(64);
}
if (args.includes("-o") || args.includes("--output-last-message")) {
  process.stderr.write("codex-exec-buffered owns final-message output; -o/--output-last-message is not supported.\n");
  process.exit(64);
}

const codexBin = process.env.CTB_CODEX_BIN || "codex";
const child = spawn(codexBin, ["exec", "--json", ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "inherit"],
});

let finalMessage = null;
let turnCompleted = false;
let parseFailed = false;

const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    parseFailed = true;
    return;
  }
  if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
    finalMessage = event.item.text;
  } else if (event?.type === "turn.completed") {
    turnCompleted = true;
  } else if (event?.type === "turn.failed") {
    turnCompleted = false;
  }
});

child.on("error", (error) => {
  process.stderr.write(`codex-exec-buffered could not start Codex: ${error.message}\n`);
  process.exitCode = 127;
});

child.on("close", (code, signal) => {
  if (signal) {
    process.stderr.write(`codex-exec-buffered: Codex exited from signal ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  if (parseFailed || !turnCompleted || finalMessage === null) {
    process.stderr.write("codex-exec-buffered: completed Codex output did not contain one usable final message.\n");
    process.exitCode = 65;
    return;
  }
  process.stdout.write(finalMessage.endsWith("\n") ? finalMessage : `${finalMessage}\n`);
});
