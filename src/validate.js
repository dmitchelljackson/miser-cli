const fs = require('fs');
const path = require('path');
const AGENTS = require('./agents/index');
const chalk = require('chalk');

async function validateAgents() {
  const agentDefs = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8')
  ).filter((a) => a.enabled);

  const errors = [];
  for (const def of agentDefs) {
    const impl = AGENTS[def.id];
    if (!impl) continue;

    const installed = await impl.checkInstalled();
    if (!installed) {
      errors.push(`${def.name} is not installed`);
      continue;
    }
    const authed = await impl.checkAuthed();
    if (!authed) {
      errors.push(`${def.name} is not authenticated`);
    }
  }
  return errors;
}

// Call this before any command except setup. Exits on failure.
async function requireAllAgentsReady() {
  const errors = await validateAgents();
  if (errors.length > 0) {
    console.error(chalk.red('\n✗ Not all agents are ready:\n'));
    for (const e of errors) {
      console.error(`  ${chalk.red('•')} ${e}`);
    }
    console.error(`\n  Run ${chalk.cyan('miser setup')} to see install and auth instructions.\n`);
    process.exit(1);
  }
}

module.exports = { validateAgents, requireAllAgentsReady };
