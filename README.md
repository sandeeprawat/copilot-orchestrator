# Copilot CLI Autonomous Orchestrator

An autonomous task orchestrator that uses GitHub Copilot CLI as its execution engine. It accepts tasks, spawns Copilot agents to complete them, evaluates results, and self-improves — running indefinitely.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                Orchestrator Daemon                  │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────┐   │
│  │  Inbox    │→│  Queue    │→│   Executor        │  │
│  │  Watcher  │  │ (SQLite) │  │  (spawns copilot) │  │
│  └──────────┘  └──────────┘  └────────┬──────────┘  │
│                                       ↓             │
│                                ┌─────────────┐      │
│                                │  Evaluator   │      │
│                                │ (self-refine)│      │
│                                └─────────────┘      │
└─────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Start the daemon (runs forever, waiting for tasks)
node src/cli.js start

# In another terminal, add tasks:
node src/cli.js add "Create a REST API with Express that has CRUD for users"
node src/cli.js add "Write unit tests for the auth module" --workdir Q:\src\myapp

# Or drop a JSON file into the tasks/ directory
cp sample-tasks.json tasks/my-tasks.json

# Check status
node src/cli.js status
node src/cli.js list
node src/cli.js show <task-id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start the orchestrator daemon |
| `add <prompt>` | Add a single task |
| `import <file>` | Import tasks from a JSON file |
| `list` | List all tasks |
| `status` | Show queue statistics |
| `show <id>` | Show task details and result |

### Options for `add`

| Option | Description |
|--------|-------------|
| `--workdir, -w` | Working directory for the task |
| `--priority, -p` | Priority (1 = highest, default: 5) |
| `--max-refinements, -r` | Max self-improvement iterations |
| `--timeout, -t` | Timeout in seconds |
| `--id` | Custom task ID |

### Options for `start`

| Option | Description |
|--------|-------------|
| `--concurrency, -c` | Max concurrent agents (default: 3) |
| `--debug, -d` | Enable debug logging |

## Task JSON Format

Drop files into the `tasks/` directory — they'll be auto-detected and queued:

```json
[
  {
    "id": "optional-custom-id",
    "prompt": "Create a REST API in Express that...",
    "workdir": "Q:\\src\\my-project",
    "maxRefinements": 3,
    "timeout": 300000,
    "priority": 1,
    "tags": ["api", "express"],
    "copilotArgs": ["--add-dir", "Q:\\src\\shared"]
  }
]
```

## Self-Improvement

After each task completes, the orchestrator:
1. Sends the task result to a Copilot evaluation agent
2. The evaluator scores the result (1-10) and decides if it passes (≥7)
3. If it fails, the evaluator generates an improved prompt
4. A new refinement task is auto-queued with the improved prompt
5. This repeats up to `maxRefinements` times (default: 3)

## Configuration

Create `orchestrator.config.json` in the project root:

```json
{
  "maxConcurrency": 5,
  "pollIntervalMs": 3000,
  "taskTimeoutMs": 900000,
  "maxRefinements": 5,
  "copilotBin": "copilot"
}
```

## Logs

- Per-task logs: `logs/task-<id>.log`
- Session transcripts: `logs/session-<id>.md`
