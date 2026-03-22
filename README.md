# miser

> Get the most out of free-tier AI coding agents by routing prompts through them automatically — frontier models, zero dollars.

The AI coding agent landscape is crowded right now, and most of the major players offer generous free tiers to win you over. miser is a single CLI that sits in front of all of them. You send it a prompt, it tries your preferred agent first, and when that one hits its daily limit it quietly falls through to the next one. By the end of the chain you've got access to thousands of free requests per day across multiple frontier-class models before you even touch a paid tier.

It's not a wrapper or an abstraction — it just invokes the real CLI tools you already have installed, in the order you configure, and hands you back the result. Think of it as a load balancer for your free AI credits.

**Why miser?**
- AI coding agents have daily and monthly free limits. Hit one, move on automatically instead of waiting or paying.
- Most free tiers reset every 24 hours. With a few agents in the chain you're unlikely to exhaust all of them in a day.
- You stay on the real tools — auth, context, and file access all work exactly as each agent intends.
- Supports long-running agentic work via the `--ralph` loop mode: agents iterate on a task across sessions until it's done, resuming automatically if interrupted.

**Agents (in default priority order):**
1. [Claude Code](https://claude.ai/code) — your paid subscription, always tried first
2. [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Gemini 2.5, 1,000 req/day free
3. [Qwen Code](https://github.com/QwenLM/qwen-code) — Qwen3-Coder (frontier-class), 1,000 req/day free
4. [Mistral Vibe](https://github.com/mistralai/mistral-vibe) — Devstral-2, ~1B tokens/month free

All four are frontier or near-frontier models. The order is configurable.

---

## ⚠️ Permissions Warning

**By default, miser runs all agents in unsafe/auto-approve mode.** This means agents will read, write, and execute code on your machine without asking for permission on each action.

This is intentional — it's what makes non-interactive use possible. If you want agents to prompt before each action, use the `--coward` flag:

```bash
miser --coward "refactor the payment module"
```

Note: Mistral Vibe is skipped entirely in coward mode because it cannot run non-interactively without auto-approve.

The `--coward` flag is a joke. The risk it guards against is not.

Look — we called it `--coward` because it's funny, not because running with guardrails is a bad idea. Unsafe mode hands an AI agent the keys to your machine and says "go nuts." It can read your files, write your files, delete your files, run shell commands, install things, and make network calls. All without asking. That's the whole point — it's fast and non-interactive. But it also means if the model has a bad day, so do you.

If you're running miser in unsafe mode (again, the default), please actually think about what you're pointing it at. On a personal dev machine with nothing sensitive? Probably fine. On a box with production credentials sitting around? Maybe don't. Not sure? Throw it in a VM or a container first — your future self will thank you. And for the love of all things holy, don't run it as root.

---

## Installation

### Prerequisites

Install the agent CLIs you want to use:

```bash
# Claude Code (paid — skip if you want fully free, see below)
npm install -g @anthropic-ai/claude-code

# Gemini CLI (free — 1,000 req/day with a Google account)
npm install -g @google/gemini-cli

# Qwen Code (free — 1,000 req/day with a Qwen account)
npm install -g @qwen-code/qwen-code

# Mistral Vibe (free — ~1B tokens/month)
pip install mistral-vibe
```

### Install miser

```bash
npm install -g miser-cli
```

### Authenticate

Run the setup wizard to verify each agent is installed and authenticated:

```bash
miser setup
```

This shows a status table and prints exact install/auth instructions for anything that isn't ready:

```
miser — agent status

┌──────────────────────┬─────────────┬───────────┐
│ Agent                │ Installed   │ Authed    │
├──────────────────────┼─────────────┼───────────┤
│ Claude Code          │ ✓           │ ✓         │
│ Gemini CLI           │ ✓           │ ✓         │
│ Qwen Code            │ ✓           │ ✓         │
│ Mistral Vibe         │ ✓           │ ✓         │
└──────────────────────┴─────────────┴───────────┘

✓ All agents installed and authenticated.
```

---

## Usage

```bash
# Basic prompt
miser "fix the bug in auth.js"

# Pass context files
miser "what does this do?" --files src/auth.js src/db.js

# Prompt from a file
miser --prompt-file task.md --files src/auth.js

# Coward mode (ask before every action)
miser --coward "refactor the payment module"

# Ralph loop — keeps working until the agent says it's done
miser --ralph "build a REST API with tests"

# Ralph loop with a judge review step
miser --ralph --judge "implement the feature"

# Ralph loop + judge + requirements file
miser --ralph --judge --requirements SPEC.md "implement the feature"
```

### Options

| Flag | Description |
|---|---|
| `--prompt-file <path>` | Read prompt from a file |
| `--files <paths...>` | Ancillary context files to include |
| `--coward` | Require permission for each action (default: auto-approve) |
| `--ralph` | Loop agents until the task is marked complete |
| `--judge` | After completion, run a judge to approve or send back for rework (requires `--ralph`) |
| `--judge-agent <id>` | Which agent to use as judge (default: `claude`) |
| `--requirements <path>` | Requirements file for the judge to compare against |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Completed successfully |
| `1` | All agents exhausted — run `miser setup` to diagnose |
| `2` | Network/server error |

---

## Ralph Loop

The `--ralph` flag runs your prompt in an iterative loop based on the [Ralph Wiggum loop](https://ghuntley.com/ralph/) pattern. Each iteration:

1. The agent reads the original prompt and accumulated context from `./miser/ralph/context.md`
2. Makes progress on the task
3. **Must** append a progress update to `./miser/ralph/context.md` before stopping
4. If all work is done, emits `<ralph-status>COMPLETE</ralph-status>` — otherwise the loop continues

The loop is resilient:
- **Network error:** retries the same agent after 1 minute
- **All agents rate-limited:** waits 30 minutes, restarts from the top of the hierarchy
- **Interrupted** (Ctrl+C, system shutdown, etc.): automatically resumes from where it left off on next run — pre-existing context is never wiped

With `--judge`, a separate judge agent (default: Claude Code) reviews the completed work and either approves it or sends it back with feedback for another loop.

---

## Going Fully Free (Disable Claude Code)

If you want miser to run without any paid subscription, disable Claude Code in `agents.json`:

```json
[
  {
    "id": "claude",
    "name": "Claude Code",
    "command": "claude",
    "priority": 1,
    "enabled": false
  },
  ...
]
```

With Claude disabled, miser falls through to:
1. **Gemini CLI** — Gemini 2.5, 1,000 req/day free with a Google account
2. **Qwen Code** — Qwen3-Coder (frontier-class), 1,000 req/day free with a Qwen account
3. **Mistral Vibe** — Devstral-2, ~1B tokens/month free (no card required)

Between Gemini and Qwen you get ~2,000 free requests per day from frontier-class models before Mistral's effectively unlimited free tier kicks in as a final fallback.

**To set up free-only agents:**

```bash
# Gemini — sign in with your Google account
gemini auth

# Qwen — create a free account at qwen.ai
qwen login

# Mistral Vibe — no login required, just install and go
pip install mistral-vibe
```

You can also reorder agents in `agents.json` by changing their `priority` values.

---

## Status & Logs

Every invocation writes to `./miser/` in the current directory:

| File | Contents |
|---|---|
| `miser/status.json` | Current state: which agent ran, success/failure, timestamps |
| `miser/miser.log` | Full run log — tail this for real-time updates |
| `miser/ralph/status.json` | Ralph loop state (for resume) |
| `miser/ralph/context.md` | Accumulated agent context across iterations |
| `miser/ralph/judge-feedback.md` | Latest judge feedback (if using `--judge`) |

```bash
# Follow a running ralph loop in real-time
tail -f ./miser/miser.log
```

---

## Configuring Agent Order

Edit `agents.json` (found in the miser package directory, or override via the file in your project) to change agent priority or disable agents:

```json
[
  { "id": "claude",  "name": "Claude Code",  "command": "claude", "priority": 1, "enabled": true },
  { "id": "gemini",  "name": "Gemini CLI",   "command": "gemini", "priority": 2, "enabled": true },
  { "id": "qwen",    "name": "Qwen Code",    "command": "qwen",   "priority": 3, "enabled": true },
  { "id": "mistral", "name": "Mistral Vibe", "command": "vibe",   "priority": 4, "enabled": true }
]
```

---

## License

MIT
