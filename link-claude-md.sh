#!/usr/bin/env bash
# Link CLAUDE.md → README.md so Claude Code reads the same docs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ln -sf README.md CLAUDE.md
echo "Linked CLAUDE.md → README.md"
