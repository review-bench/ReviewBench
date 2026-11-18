/**
 * `JSON.parse`, retried without any backslash in a string that doesn't start a
 * valid JSON escape. Judges sometimes write a JavaScript-style escape in a
 * string, such as `\`` for a backtick, which JSON rejects; the retry reads it
 * as the character itself. Valid escapes are kept, backslashes outside strings
 * are left to fail, and JSON that parses is unchanged.
 */
export function parseJsonAllowingInvalidEscapes(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const repaired = dropInvalidEscapesInStrings(text);
    if (repaired === text) throw error;
    try {
      return JSON.parse(repaired);
    } catch {
      throw error;
    }
  }
}

/** `text` without the backslashes inside its JSON strings that don't start a valid escape. */
function dropInvalidEscapesInStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inString = !inString;
    if (!inString || c !== "\\") {
      out += c;
      continue;
    }
    const next = text[i + 1] ?? "";
    const valid = '"\\/bfnrt'.includes(next) || (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)));
    if (valid && next !== "") {
      out += c + next;
      i++;
    }
  }
  return out;
}
