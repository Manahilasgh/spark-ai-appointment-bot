/**
 * Reveals queued text at a steady pace. AI providers often deliver short answers in one or two bursts;
 * this makes the text still read as being written. The pace speeds up automatically if a long backlog builds up.
 */
export class Typewriter {
  private queue = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters: (() => void)[] = [];

  constructor(private onText: (piece: string) => void) {}

  push(text: string) {
    this.queue += text;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 16);
  }

  private tick() {
    if (!this.queue) return this.stop();
    let n = Math.max(2, Math.ceil(this.queue.length / 25));
    const code = this.queue.charCodeAt(n - 1);
    if (code >= 0xd800 && code <= 0xdbff) n++; // never split an emoji in half
    const piece = this.queue.slice(0, n);
    this.queue = this.queue.slice(n);
    this.onText(piece);
    if (!this.queue) this.stop();
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  /** Resolves once everything pushed so far has been shown. */
  drain(): Promise<void> {
    return this.timer ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }

  cancel() {
    this.queue = '';
    this.stop();
  }
}
