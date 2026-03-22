# miser

> Frontier AI coding agents, free tier, no babysitting required.

> [!NOTE]
> This project was 100% vibe coded. Every line of it. It is very much alpha software and may be rough around the edges — use it, break it, file issues, send PRs. You have been warned (and you're about to be warned again, further down, about the VM thing).

The AI coding agent landscape is crowded right now and most of the major players offer generous free tiers to win you over. The problem is they all have daily limits, and when you hit one you're just... stuck. Waiting. Or paying.

miser fixes that. It's a single CLI that sits in front of all of them. Send it a prompt, it tries your preferred agent first, and when that one hits its limit it quietly falls through to the next one. By the time you've chained a few agents together you've got thousands of free requests per day across frontier-class models before you even think about opening your wallet.

It's not a wrapper or an abstraction — it just invokes the real CLI tools you already have installed, in the order you configure, and hands you back the result. Think of it as a load balancer for your free AI credits.

**Why miser?**
- Hit a rate limit? Move on automatically instead of waiting or paying.
- Free tiers reset every 24 hours. With a few agents in the chain you're unlikely to exhaust all of them in a day.
- You're on the real tools the whole time — auth, context, and file access all work exactly as each agent intends.
- Got a big task? `--ralph` mode loops agents iteratively until the work is done, picking up right where it left off if something interrupts it.

**Agents (in default priority order):**
1. [Claude Code](https://claude.ai/code) — your paid subscription goes first (skip it if you want fully free — see below)
2. [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Gemini 2.5, 1,000 req/day free with a Google account
3. [Qwen Code](https://github.com/QwenLM/qwen-code) — Qwen3-Coder (frontier-class), 1,000 req/day free with a Qwen account
4. [Mistral Vibe](https://github.com/mistralai/mistral-vibe) — Devstral-2, ~1B tokens/month free, no card required

All four are frontier or near-frontier models. The order is yours to configure.

---

## ⚠️ Permissions Warning

**By default, miser runs all agents in unsafe/auto-approve mode.** Agents will read, write, and execute code on your machine without stopping to ask permission on each action. That's intentional — it's what makes non-interactive use possible.

If you'd rather agents ask before doing anything destructive, use the `--coward` flag:

```bash
miser --coward "refactor the payment module"
```

One caveat: Mistral Vibe gets skipped entirely in coward mode because it physically cannot run non-interactively without auto-approve. That's on them, not us.

> [!WARNING]
> The `--coward` flag is a joke. The risk it guards against is not.
>
> Look — we called it `--coward` because it's funny, not because running with guardrails is a bad idea. Unsafe mode hands an AI agent the keys to your machine and says "go nuts." It can read your files, write your files, delete your files, run shell commands, install things, and make network calls. All without asking. That's the whole point — it's fast and non-interactive. But it also means if the model has a bad day, so do you.
>
> If you're running miser in unsafe mode (again, the default), please actually think about what you're pointing it at. On a personal dev machine with nothing sensitive? Probably fine. On a box with production credentials sitting around? Maybe don't. Not sure? Throw it in a VM or a container first — your future self will thank you. And for the love of all things holy, don't run it as root.

---

## Installation

### Step 1 — Install the agent CLIs you want

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started) — paid, but your subscription goes first so it's worth it
- [Gemini CLI](https://github.com/google-gemini/gemini-cli#getting-started) — free, 1,000 req/day with a Google account
- [Qwen Code](https://github.com/QwenLM/qwen-code#getting-started) — free, 1,000 req/day with a Qwen account
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe#installation) — free, ~1B tokens/month, no account needed

### Step 2 — Install miser

```bash
npm install -g dmitchelljackson/miser-cli
```

### Step 3 — Check everything works

```bash
miser setup
```

This shows you a table of what's installed and authenticated, and tells you exactly what to do for anything that isn't:

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
# The basics
miser "fix the bug in auth.js"

# Give it some context files to work with
miser "what does this do?" --files src/auth.js src/db.js

# Read the prompt from a file (useful for longer tasks)
miser --prompt-file task.md --files src/auth.js

# Coward mode — agents ask before each action
miser --coward "refactor the payment module"

# Ralph mode — loop until the task is done
miser --ralph "build a REST API with tests"

# Ralph mode with a judge that reviews the work before signing off
miser --ralph --judge "implement the feature"

# Same, but give the judge a requirements file to compare against
miser --ralph --judge --requirements SPEC.md "implement the feature"
```

### Flags

| Flag | Description |
|---|---|
| `--prompt-file <path>` | Read the prompt from a file instead of inline |
| `--files <paths...>` | Context files to include (source files, specs, etc.) |
| `--coward` | Ask for permission before each agent action (default: auto-approve) |
| `--ralph` | Loop agents until the task is marked complete |
| `--judge` | After completion, run a judge agent to approve or send back for rework (requires `--ralph`) |
| `--judge-agent <id>` | Which agent to use as judge — must match an id in `agents.json` (default: `claude`) |
| `--requirements <path>` | Requirements file for the judge to compare the work against |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Done — check `./miser/status.json` for which agent got you there |
| `1` | All agents exhausted — run `miser setup` to figure out why |
| `2` | Network or server error |

---

## Ralph Loop

Named after the [Ralph Wiggum loop](https://ghuntley.com/ralph/) pattern — the idea is simple: just keep running the agent until it says it's done.

With `--ralph`, each iteration the agent gets the original prompt plus everything accumulated in `./miser/ralph/context.md` from previous runs. It does some work, appends a progress update to that file, and either emits `<ralph-status>COMPLETE</ralph-status>` to signal it's finished or just exits and lets the loop fire it up again.

It's more resilient than it sounds:
- **Network error** — retries the same agent after 1 minute
- **All agents rate-limited** — waits 30 minutes and starts back at the top of the hierarchy
- **Interrupted** (Ctrl+C, laptop closes, power dies) — picks up exactly where it left off next time you run it. Context is never wiped.

Throw `--judge` on top and once the worker says it's done, a separate judge agent (Claude by default) reviews the output against the original prompt. Approved? Done. Not satisfied? It sends feedback back to the worker and the loop continues.

---

## Going Fully Free

Don't have a Claude subscription or just want to go full free-tier? Disable Claude Code in `agents.json`:

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

With Claude out of the picture miser falls through to:
1. **Gemini CLI** — Gemini 2.5, 1,000 req/day free
2. **Qwen Code** — Qwen3-Coder, 1,000 req/day free
3. **Mistral Vibe** — Devstral-2, ~1B tokens/month free (no card, no account, just vibes)

That's roughly 2,000 free requests per day from genuine frontier models before Mistral's effectively unlimited tier kicks in as a safety net. Not bad for zero dollars.

Follow the setup instructions for each one you want:
- [Gemini CLI](https://github.com/google-gemini/gemini-cli#getting-started)
- [Qwen Code](https://github.com/QwenLM/qwen-code#getting-started)
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe#installation) — free API key from [console.mistral.ai](https://console.mistral.ai), no card required

---

## Status & Logs

Every run writes to `./miser/` in your current directory. The header miser prints at startup tells you exactly where to look:

```
[miser] Status file: ./miser/status.json
[miser] Log file:    ./miser/miser.log
[miser] Tail logs:   tail -f ./miser/miser.log
```

| File | What's in it |
|---|---|
| `miser/status.json` | Which agent ran, what happened, timestamps |
| `miser/miser.log` | Full play-by-play of the run |
| `miser/ralph/status.json` | Ralph loop state — how miser knows where to resume |
| `miser/ralph/context.md` | Everything the agents have written across iterations |
| `miser/ralph/judge-feedback.md` | The judge's last rejection note (if using `--judge`) |

---

## Configuring Agent Order

`agents.json` controls which agents run and in what order. Change `priority` to reorder, set `enabled: false` to skip one entirely:

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
