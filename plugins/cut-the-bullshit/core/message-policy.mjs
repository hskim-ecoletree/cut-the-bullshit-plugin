export const MESSAGE_POLICY = Object.freeze({ shortSentences: 3, shortChars: 400, codeRatio: 0.5 });

export function sentenceCount(text) {
  const matches = String(text ?? "").match(/[.!?][\s"'`)\]]*(?=\s|$)/g);
  return matches?.length ?? 0;
}

export function codeLineRatio(text) {
  let fenced = false;
  let code = 0;
  let body = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; code += 1; body += 1; continue; }
    if (!line.trim()) continue;
    body += 1;
    if (fenced || /^\s{4,}\S/.test(line) || /^\s*[+-]{3}\s|^\s*@@ /.test(line) || /^[+-](?![+-])/.test(line)) code += 1;
  }
  return body === 0 ? 0 : code / body;
}

export function isExemptMessage(message, policy = MESSAGE_POLICY) {
  const text = String(message ?? "");
  return (text.length <= policy.shortChars && sentenceCount(text) <= policy.shortSentences)
    || codeLineRatio(text) >= policy.codeRatio;
}
