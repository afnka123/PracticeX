// Parses a JSON document that is still being written, e.g. "{"a": [1, 2], "b": "hel".
// Returns the most complete value it can: unfinished strings are closed, unfinished keys, numbers and
// literals are dropped, and open objects and arrays are closed. Returns undefined if nothing is usable.

const CLOSE = { "{": "}", "[": "]" };

function trimEscape(body) {
  // Drop a half-written escape at the end: a lone backslash or an incomplete \uXXXX.
  body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  const slashes = body.match(/\\+$/);
  if (slashes && slashes[0].length % 2 === 1) body = body.slice(0, -1);
  return body;
}

export function parsePartialJson(text) {
  const stack = [];
  let expectKey = false;
  let best = null; // latest prefix that ends on a complete value: { end, extra, closers }
  const mark = (end, extra = "") => {
    best = { end, extra, closers: stack.map((c) => CLOSE[c]).reverse().join("") };
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const isKey = stack.at(-1) === "{" && expectKey;
      let j = i + 1;
      let escaped = false;
      for (; j < text.length; j++) {
        const d = text[j];
        if (escaped) escaped = false;
        else if (d === "\\") escaped = true;
        else if (d === '"') break;
      }
      if (j >= text.length) {
        if (!isKey) mark(i, trimEscape(text.slice(i)) + '"');
        break;
      }
      i = j + 1;
      if (isKey) expectKey = false;
      else mark(i);
    } else if (c === "{" || c === "[") {
      stack.push(c);
      expectKey = c === "{";
      i++;
      mark(i);
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
      i++;
      mark(i);
    } else if (c === ",") {
      expectKey = stack.at(-1) === "{";
      i++;
    } else if (c === ":") {
      expectKey = false;
      i++;
    } else if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++;
    } else {
      // Number or literal: only complete once a delimiter follows it.
      let j = i;
      while (j < text.length && !/[\s,\]}]/.test(text[j])) j++;
      if (j >= text.length) break;
      i = j;
      mark(i);
    }
  }
  if (!best) return undefined;
  try {
    return JSON.parse(text.slice(0, best.end) + best.extra + best.closers);
  } catch {
    return undefined;
  }
}
