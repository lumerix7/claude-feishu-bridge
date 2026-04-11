# Feishu Rendering Caveats

Large fenced output can render differently across Feishu clients even when the outbound markdown is valid.

- Desktop and mobile do not always style the same chunked fenced block the same way.
- The gateway should preserve line boundaries when splitting oversized fenced/raw text blocks.
- Streaming should only split truly huge single lines, and only within that source line.
- Command and diagnostic output should stay source-shaped; avoid adding command-specific rendering hacks to work around one client.

When changing pagination or streaming behavior, verify at least one large fenced block on both desktop and mobile Feishu.
