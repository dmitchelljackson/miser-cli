const fs = require('fs');
const path = require('path');
const AGENTS = require('./agents/index');
const logger = require('./logger');
const status = require('./status');

function loadAgentOrder(overridePath) {
  // TODO: --order flag support for custom order.json — not yet implemented
  const configPath = overridePath || path.join(__dirname, '..', 'agents.json');
  const agents = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return agents
    .filter((a) => a.enabled && AGENTS[a.id])
    .sort((a, b) => a.priority - b.priority);
}

function buildPrompt(promptText, files) {
  if (!files || files.length === 0) return promptText;

  const fileSections = files.map((filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return `--- FILE: ${filePath} ---\n${content}\n--- END FILE ---`;
    } catch (err) {
      logger.warn(`Could not read file ${filePath}: ${err.message}`);
      return null;
    }
  }).filter(Boolean);

  if (fileSections.length === 0) return promptText;

  return `<context>\n${fileSections.join('\n\n')}\n</context>\n\n${promptText}`;
}

// Exit codes
const EXIT = {
  SUCCESS: 0,
  EXHAUSTED: 1,
  NETWORK: 2,
};

async function run({ prompt, files = [], unsafe = true }) {
  const agents = loadAgentOrder();

  if (agents.length === 0) {
    logger.error('No enabled agents found in agents.json');
    process.exit(EXIT.EXHAUSTED);
  }

  const fullPrompt = buildPrompt(prompt, files);

  for (let i = 0; i < agents.length; i++) {
    const agentDef = agents[i];
    const agentImpl = AGENTS[agentDef.id];
    const position = `${i + 1}/${agents.length}`;

    logger.info(`Trying ${agentDef.name} (${position})...`);
    status.setAgent(agentDef.id);

    const result = await agentImpl.run(fullPrompt, { unsafe });

    if (result.success) {
      status.recordAttempt(agentDef.id, 'success');
      status.complete(agentDef.id);
      logger.success(`Completed by ${agentDef.name}`);
      // Print result to stdout for consumption by callers
      process.stdout.write(result.output);
      if (!result.output.endsWith('\n')) process.stdout.write('\n');
      return EXIT.SUCCESS;
    }

    if (result.failureType === 'network') {
      status.networkError(agentDef.id);
      logger.error(`Network/server error from ${agentDef.name} — failing fast`);
      process.stderr.write(`\n[miser] Error: network or server error from ${agentDef.name}\n`);
      if (result.detail) process.stderr.write(`[miser] Detail: ${result.detail}\n`);
      return EXIT.NETWORK;
    }

    if (result.failureType === 'rate_limit') {
      status.recordAttempt(agentDef.id, 'rate_limit');
      logger.warn(`${agentDef.name} rate limited — falling through`);
      continue;
    }

    if (result.failureType === 'not_installed') {
      status.recordAttempt(agentDef.id, 'not_installed');
      logger.warn(`${agentDef.name} not installed — skipping`);
      continue;
    }

    if (result.failureType === 'coward_unsupported') {
      status.recordAttempt(agentDef.id, 'skipped', 'coward mode not supported');
      logger.warn(`${agentDef.name} does not support coward mode — skipping`);
      continue;
    }

    if (result.failureType === 'auth') {
      status.recordAttempt(agentDef.id, 'auth');
      logger.warn(`${agentDef.name} not authenticated — skipping`);
      continue;
    }

    // Unknown failure — skip and continue
    status.recordAttempt(agentDef.id, 'failed', result.failureType);
    logger.warn(`${agentDef.name} failed (${result.failureType || 'unknown'}) — skipping`);
  }

  status.exhaust();
  logger.error('All agents exhausted — no agent could satisfy the request');
  process.stderr.write('\n[miser] Error: all agents exhausted\n');
  process.stderr.write('[miser] Run `miser setup` to check agent status\n');
  return EXIT.EXHAUSTED;
}

module.exports = { run, EXIT };
