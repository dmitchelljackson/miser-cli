#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const logger = require('../src/logger');
const status = require('../src/status');
const runner = require('../src/runner');
const setup = require('../src/setup');
const ralph = require('../src/ralph');
const { requireAllAgentsReady } = require('../src/validate');

const program = new Command();

program
  .name('miser')
  .description(
    'Route coding prompts through a hierarchy of free-tier AI coding agents.\n' +
    'Tries each agent in priority order, falling through on rate limits.\n' +
    'Agents: Claude Code → Gemini CLI → Qwen Code → Mistral Vibe'
  )
  .version('0.1.0')
  .addHelpText('after', `
Examples:
  $ miser setup
  $ miser "fix the bug in auth.js"
  $ miser --prompt-file task.md --files src/auth.js src/db.js
  $ miser --coward "refactor this module"
  $ miser --ralph "build a REST API with tests"
  $ miser --ralph --judge "implement the feature in SPEC.md"
  $ miser --ralph --judge --judge-agents claude gemini "implement the feature"
  $ miser --ralph --judge --requirements SPEC.md "implement the feature"
`);

// ─── setup ────────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description(
    'Check that all agents are installed and authenticated.\n' +
    'Shows a status table and prints install/auth instructions for anything missing.\n' +
    'This is the only command that runs without all agents being ready.'
  )
  .addHelpText('after', `
Example:
  $ miser setup
`)
  .action(async () => {
    await setup.run();
  });

// ─── run (default) ────────────────────────────────────────────────────────────
program
  .command('run [prompt]', { isDefault: true })
  .description(
    'Send a prompt through the agent hierarchy and return the result.\n' +
    'Agents are tried in priority order (see agents.json). Falls through to\n' +
    'the next agent on rate limits or auth failures. Fast-fails on network errors.\n\n' +
    'Unsafe mode (default): agents run with all permissions auto-approved.\n' +
    'Coward mode (--coward): agents prompt for permission on each action.\n\n' +
    'Exit codes:\n' +
    '  0  completed successfully (check which agent via ./miser/status.json)\n' +
    '  1  all agents exhausted — run `miser setup` to diagnose\n' +
    '  2  network/server error'
  )
  .option(
    '--prompt-file <path>',
    'Read the prompt from a file instead of inline'
  )
  .option(
    '--files <paths...>',
    'Ancillary context files to inline into the prompt (e.g. source files for context)'
  )
  .option(
    '--coward',
    'Coward mode: require explicit user approval for each agent action.\n' +
    '                         Default is unsafe mode (auto-approve everything).\n' +
    '                         Note: Mistral Vibe is skipped in coward mode (cannot run without auto-approve).'
  )
  .option(
    '--ralph',
    'Ralph loop mode: run agents in a loop until the task is marked complete.\n' +
    '                         Each iteration the agent reads accumulated context from\n' +
    '                         ./miser/ralph/context.md and appends a progress update.\n' +
    '                         The loop resumes automatically if interrupted.\n' +
    '                         Retry on network error: 1 min. All agents exhausted: 30 min.'
  )
  .option(
    '--judge',
    'After the worker marks complete, run a judge agent to review the work.\n' +
    '                         If rejected, feedback is saved and the worker loops again.\n' +
    '                         Requires --ralph. Judge defaults to Claude Code.\n' +
    '                         Judge retry on network error: 1 min. Rate limit: 30 min.'
  )
  .option(
    '--judge-agent <id>',
    'Which agent to use as judge. Must match an id in agents.json.\n' +
    '                         (default: claude). Use --judge-agents for multiple judges.',
    'claude'
  )
  .option(
    '--judge-agents <ids...>',
    'Multiple judges to try in priority order (e.g., --judge-agents claude gemini qwen).\n' +
    '                         Falls through to next judge on rate limits or failures.\n' +
    '                         Each ID must match an id in agents.json.'
  )
  .option(
    '--requirements <path>',
    'A requirements or spec file for the judge to compare the work against.\n' +
    '                         Used with --judge. If omitted, the judge uses the original prompt.'
  )
  .addHelpText('after', `
Examples:
  # Single-shot prompt
  $ miser "what does this function do?" --files src/utils.js

  # From a prompt file with context files
  $ miser --prompt-file task.md --files src/auth.js src/db.js

  # Ralph loop: keep working until done
  $ miser --ralph "build a CLI tool with tests"

  # Ralph loop with judge review
  $ miser --ralph --judge "implement user auth"

  # Ralph loop with judge + requirements file
  $ miser --ralph --judge --requirements SPEC.md "implement the feature"

  # Coward mode (ask before every action)
  $ miser --coward "refactor the payment module"

Status and logs are written to ./miser/ in the current directory.
`)
  .action(async (promptArg, opts) => {
    // Validate flag combos
    if (opts.judge && !opts.ralph) {
      console.error(chalk.red('\n✗ --judge requires --ralph\n'));
      process.exit(1);
    }

    const cwd = process.cwd();
    const unsafe = !opts.coward;

    // Resolve prompt
    let prompt = promptArg || '';
    if (opts.promptFile) {
      if (!fs.existsSync(opts.promptFile)) {
        console.error(`[miser] Error: prompt file not found: ${opts.promptFile}`);
        process.exit(1);
      }
      prompt = fs.readFileSync(opts.promptFile, 'utf8').trim();
    }

    if (!prompt) {
      console.error('[miser] Error: provide a prompt as an argument or via --prompt-file');
      process.exit(1);
    }

    // Validate all agents are ready before doing any work
    await requireAllAgentsReady();

    // ── Ralph mode ────────────────────────────────────────────────────────────
    if (opts.ralph) {
      logger.init(cwd);
      console.error(logger.getLogInfo(cwd));

      const result = await ralph.run({
        prompt,
        files: opts.files || [],
        unsafe,
        judge: !!opts.judge,
        judgeAgent: opts.judgeAgent,
        judgeAgents: opts.judgeAgents || null,
        requirementsFile: opts.requirements || null,
        cwd,
      });

      process.exit(result.success ? 0 : 1);
    }

    // ── Standard single-shot mode ─────────────────────────────────────────────
    logger.init(cwd);
    status.init(cwd, prompt);
    console.error(logger.getLogInfo(cwd));

    const exitCode = await runner.run({
      prompt,
      files: opts.files || [],
      unsafe,
    });

    process.exit(exitCode);
  });

program.parse(process.argv);
