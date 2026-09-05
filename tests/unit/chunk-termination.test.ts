import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// A subprocess bounds the real synchronous loop, even when Vitest's own
// timeout cannot interrupt it. No implementation is copied into this test.
it("production chunking terminates and preserves pathological tokens", () => {
  const script = `
    import { planChunks } from './src/domain/spoken/speech-plan.ts';
    const inputs = [399,400,401,800,10000].map(n => 'a'.repeat(n));
    inputs.push('a'.repeat(1000000), 'https://example.test/'+'a'.repeat(10000), 'aB9+/='.repeat(2000),
      '界😀'.repeat(3000), 'a,b;c!'.repeat(1000), 'Texto ordinario. '.repeat(100));
    for (const text of inputs) {
      const chunks = planChunks({segments:[{id:'s0',text}]},400);
      if(chunks.some(c => !c.text || c.text.length > 400)) throw Error('size');
      if(chunks.map(c => c.text).join('').replace(/\\s/g,'') !== text.replace(/\\s/g,'')) throw Error('content');
      let cursor = 0;
      for(const chunk of chunks) {
        while(/\\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        if(text.slice(cursor,cursor+chunk.text.length) !== chunk.text) throw Error('exact source span');
        cursor += chunk.text.length;
        if(/[\\uD800-\\uDBFF]$/.test(chunk.text)) throw Error('split surrogate');
      }
      if(text.slice(cursor).trim()) throw Error('lost tail');
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { timeout: 4000, encoding: "utf8" },
  );
  expect(result.error?.message ?? result.stderr).toBe("");
  expect(result.status).toBe(0);
});
