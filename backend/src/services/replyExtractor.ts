const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/**
 * Incrementally pulls the text of the "reply" field out of a JSON object that is arriving in pieces,
 * so the user can watch the answer being written while the rest of the JSON (intent, details) is still coming.
 * Feed it raw chunks with push(); it returns only the NEW reply characters found in each chunk.
 */
export class ReplyExtractor {
  private buf = '';
  private pos = -1; // index of the next unread char inside the reply string (-1 = reply not started yet)
  private done = false;

  push(chunk: string): string {
    if (this.done) return '';
    this.buf += chunk;

    if (this.pos < 0) {
      const start = /"reply"\s*:\s*"/.exec(this.buf);
      if (!start) return '';
      this.pos = start.index + start[0].length;
    }

    let out = '';
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos];
      if (ch === '"') {
        this.done = true; // closing quote: the reply string is complete
        this.pos++;
        break;
      }
      if (ch === '\\') {
        const next = this.buf[this.pos + 1];
        if (next === undefined) break; // escape sequence split across chunks: wait for more
        if (next === 'u') {
          if (this.pos + 6 > this.buf.length) break; // need all 4 hex digits
          const code = parseInt(this.buf.slice(this.pos + 2, this.pos + 6), 16);
          if (!Number.isNaN(code)) out += String.fromCharCode(code);
          this.pos += 6;
        } else {
          out += ESCAPES[next] ?? next;
          this.pos += 2;
        }
        continue;
      }
      out += ch;
      this.pos++;
    }
    return out;
  }
}
