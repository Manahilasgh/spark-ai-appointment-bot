// Diagnostic: shows how the AI provider actually delivers a streamed answer (chunk sizes and timing).
// Run from the backend folder:  node scripts/stream-test.js
require('dotenv/config');

(async () => {
  const url = `${process.env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      stream: true,
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Write a friendly 80-word paragraph about looking after your teeth.' }],
    }),
  });
  console.log(`HTTP ${res.status}, headers after ${Date.now() - t0}ms`);
  let n = 0;
  for await (const chunk of res.body) {
    n++;
    console.log(`+${String(Date.now() - t0).padStart(5)}ms  chunk ${n}  (${chunk.length} bytes)`);
  }
  console.log(`Done: ${n} chunks in ${Date.now() - t0}ms`);
})();
