#!/usr/bin/env bash
# Link CLAUDE.md → AGENTS.md so Claude Code reads the same docs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ln -sf AGENTS.md CLAUDE.md
echo "Linked CLAUDE.md → AGENTS.md"
