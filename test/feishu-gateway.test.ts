import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly } from "../src/adapters/feishu/feishu-gateway.js";

test("splitMessageText reopens and recloses oversized fenced code blocks on every page", () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const text = `\`\`\`text\n${body}\n\`\`\``;

  const pages = __testOnly.splitMessageText(text, 240);

  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.match(page, /^`{3,}text\n/);
    assert.match(page, /\n`{3,}$/);
  }
});

test("splitMessageText preserves line boundaries when splitting fenced raw text", () => {
  const lineA = "a".repeat(200);
  const lineB = "b".repeat(400);
  const lineC = "c".repeat(500);
  const text = `\`\`\`text\n${lineA}\n${lineB}\n${lineC}\n\`\`\``;

  const pages = __testOnly.splitMessageText(text, 620);

  assert.ok(pages.length > 1);
  assert.ok(pages.some((page) => page.includes(`${lineA}\n${lineB.slice(0, 100)}`)));
  assert.ok(pages.some((page) => page.includes(`${lineB}\n`)));
  assert.ok(!pages.some((page) => page.includes(`${lineA}${lineB.slice(0, 20)}`)));
});

test("buildStreamingLineFrames keeps normal multi-line output unsplit", () => {
  const text = ["a".repeat(315), "b".repeat(315), "c".repeat(315)].join("\n");

  const frames = __testOnly.buildStreamingLineFrames(text, 64);

  assert.equal(frames[0], "a".repeat(315));
  assert.equal(frames[1], ["a".repeat(315), "b".repeat(315)].join("\n"));
  assert.equal(frames[2], text);
});

test("buildStreamingLineFrames splits only within a truly huge source line", () => {
  const hugeLine = "x".repeat(6000);
  const secondLine = "tail";

  const frames = __testOnly.buildStreamingLineFrames(`${hugeLine}\n${secondLine}`, 64);

  assert.ok(frames.length >= 3);
  assert.equal(frames[0], hugeLine.slice(0, 2800));
  assert.equal(frames[1], hugeLine.slice(0, 5600));
  assert.equal(frames[2], hugeLine);
  assert.equal(frames.at(-1), `${hugeLine}\n${secondLine}`);
});

test("renderOutgoingBody wraps raw text once in the gateway", () => {
  const rendered = __testOnly.renderOutgoingBody("plain output", "raw-text");

  assert.equal(rendered, "```text\nplain output\n```");
});
