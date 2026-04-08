#!/bin/bash
# First-time QMD setup: create collections and run initial indexing.
# Run from project root: bash scripts/setup-qmd.sh

set -e

echo "=== QMD Setup for Claude Harness ==="

# Check prerequisites
command -v qmd >/dev/null 2>&1 || { echo "ERROR: qmd not found. Install from https://github.com/qmd-lab/qmd"; exit 1; }
command -v ollama >/dev/null 2>&1 || { echo "ERROR: ollama not found. Install from https://ollama.ai"; exit 1; }

# Check embedding model
if ! ollama list | grep -q "qwen3-embedding"; then
  echo "Pulling qwen3-embedding model..."
  ollama pull qwen3-embedding
fi

# Create workspace directories
mkdir -p workspace/memory workspace/sessions workspace/instructions workspace/data

# Seed memory file if missing
if [ ! -f workspace/memory/MEMORY.md ]; then
  echo "# Long-term Memory" > workspace/memory/MEMORY.md
  echo "" >> workspace/memory/MEMORY.md
  echo "Created MEMORY.md"
fi

# Seed global instructions if missing
if [ ! -f workspace/instructions/global.md ]; then
  cat > workspace/instructions/global.md << 'INSTRUCTIONS'
# Claude Harness — Instructions

You are an AI assistant running inside Claude Harness, a personal agent system.
You communicate through Telegram topics (each topic = isolated channel/session).

## Tools Available

### QMD — Semantic Memory Search
You have access to QMD search via MCP tools. Use it to recall past conversations,
decisions, and context:

- **qmd_query** — hybrid search (BM25 + vector + rerank). Best quality, use by default.
- **qmd_search** — keyword-only BM25 search. Fast, good for exact terms.
- **qmd_vsearch** — vector semantic search only. Good for conceptual similarity.

**Always search memory before starting complex tasks.** The user expects continuity.

### Harness MCP Tools
- **memory_save** — save important facts to long-term memory (gets indexed by QMD)
- **memory_daily** — write a note to today's daily log
- **instruction_add** — save a persistent user instruction/rule
- **channel_send** — send a message to another Telegram channel/topic
- **cron_create** — schedule a recurring task
- **cron_list** — list scheduled tasks
- **cron_delete** — remove a scheduled task

## Rules
- Search memory (qmd_query) before complex tasks to get relevant context
- Save important decisions, facts, and outcomes using memory_save
- When the user asks you to "always do X" or "remember to Y", use instruction_add
- Be concise — responses go to Telegram chat (limited formatting)
- Use Markdown sparingly (Telegram supports basic markdown only)
- When you learn something new about the user or project, save it to memory
INSTRUCTIONS
  echo "Created global.md"
fi

# Index all collections
echo ""
echo "Indexing QMD collections..."

echo "  → harness-memory (workspace/memory/)"
qmd index --collection harness-memory workspace/memory/ 2>&1 | tail -1

echo "  → harness-sessions (workspace/sessions/)"
qmd index --collection harness-sessions workspace/sessions/ 2>&1 | tail -1

echo "  → harness-instructions (workspace/instructions/)"
qmd index --collection harness-instructions workspace/instructions/ 2>&1 | tail -1

echo ""
echo "=== QMD setup complete ==="
echo "Start the harness with: bun run dev"
