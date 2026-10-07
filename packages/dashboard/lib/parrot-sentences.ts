// Heuristic streaming segmentation. Retain terminal punctuation for one-character
// lookahead (decimals/closing quotes); callers may flush after transcript silence.
export function createSentenceSplitter() {
  let buffer = "";
  function drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      let end = 0, fragmentStart = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (!/[.!?。！？…\n\r]/u.test(c)) continue;
        const token = buffer.slice(0, i).split(/\s/).at(-1) ?? "";
        if ((c === "." && /\d$/.test(token) && /[\d-]/.test(buffer[i + 1] ?? "")) ||
            (c === "…" && /0x[\da-f]+$/i.test(token) && /[\da-f]/i.test(buffer[i + 1] ?? ""))) continue;
        let j = i + 1;
        while (j < buffer.length && /[.!?。！？…"'”’」』）)\]}]/u.test(buffer[j])) j++;
        if (/[.…]/u.test(c) && /0x[\da-f]+$/i.test(token) && /^[.…]+$/.test(buffer.slice(i, j)) && /[\da-f]/i.test(buffer[j] ?? "")) { i = j - 1; continue; }
        if (j === buffer.length && !final) break;
        if (buffer.slice(fragmentStart, j).trim().length >= 12) { end = j; break; }
        fragmentStart = j; i = j - 1; // Bird noises stay attached to the next real sentence.
      }
      if ((!end && buffer.length > 200) || end > 200) {
        const prefix = buffer.slice(0, 200);
        end = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf(",") + 1, prefix.lastIndexOf("、") + 1);
        if (end < 12) end = 200;
        if (/[\uD800-\uDBFF]/.test(buffer[end - 1])) end--;
      }
      if (!end) {
        if (final) { if (buffer.trim().length >= 12) out.push(buffer.trim().replace(/\s+/g, " ")); buffer = ""; }
        break;
      }
      out.push(buffer.slice(0, end).trim().replace(/\s+/g, " ")); buffer = buffer.slice(end).trimStart();
    }
    return out;
  }
  return { push(delta: string) { buffer = (buffer + delta).trimStart(); return drain(false); }, flush() { return drain(true); }, flushIfSettled() { return /\d\.$/.test(buffer.trimEnd()) ? [] : drain(true); }, reset() { buffer = ""; } };
}
