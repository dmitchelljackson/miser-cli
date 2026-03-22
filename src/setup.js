const chalk = require('chalk');
const AGENTS = require('./agents/index');
const fs = require('fs');
const path = require('path');

const INSTALL_INSTRUCTIONS = {
  claude: {
    install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'claude login',
    docs: 'https://claude.ai/code',
  },
  gemini: {
    install: 'npm install -g @google/gemini-cli',
    auth: 'gemini auth',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  qwen: {
    install: 'npm install -g @qwen-code/qwen-code',
    auth: 'qwen login',
    docs: 'https://github.com/QwenLM/qwen-code',
  },
  mistral: {
    install: 'pip install mistral-vibe',
    auth: 'export MISTRAL_API_KEY=your_key  # get free key at console.mistral.ai',
    docs: 'https://github.com/mistralai/mistral-vibe',
  },
};

async function run() {
  const configPath = path.join(__dirname, '..', 'agents.json');
  const agentDefs = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    .sort((a, b) => a.priority - b.priority);

  console.log('\n' + chalk.bold('miser — agent status') + '\n');

  const results = await Promise.all(
    agentDefs.map(async (def) => {
      const impl = AGENTS[def.id];
      if (!impl) return { def, installed: false, authed: false };
      const installed = await impl.checkInstalled();
      const authed = installed ? await impl.checkAuthed() : false;
      return { def, installed, authed };
    })
  );

  // Table
  const colWidths = { name: 20, installed: 11, authed: 9 };
  const hr = '─'.repeat(colWidths.name + colWidths.installed + colWidths.authed + 8);

  console.log(`┌${'─'.repeat(colWidths.name + 2)}┬${'─'.repeat(colWidths.installed + 2)}┬${'─'.repeat(colWidths.authed + 2)}┐`);
  console.log(
    `│ ${chalk.bold('Agent'.padEnd(colWidths.name))} │ ${chalk.bold('Installed'.padEnd(colWidths.installed))} │ ${chalk.bold('Authed'.padEnd(colWidths.authed))} │`
  );
  console.log(`├${'─'.repeat(colWidths.name + 2)}┼${'─'.repeat(colWidths.installed + 2)}┼${'─'.repeat(colWidths.authed + 2)}┤`);

  for (const { def, installed, authed } of results) {
    const enabledLabel = def.enabled ? '' : chalk.dim(' (disabled)');
    const name = (def.name + enabledLabel).padEnd(colWidths.name);
    const installedCell = installed
      ? chalk.green('✓').padEnd(colWidths.installed + 9) // +9 for chalk escape codes
      : chalk.red('✗').padEnd(colWidths.installed + 9);
    const authedCell = !installed
      ? chalk.dim('—').padEnd(colWidths.authed + 9)
      : authed
      ? chalk.green('✓').padEnd(colWidths.authed + 9)
      : chalk.red('✗').padEnd(colWidths.authed + 9);

    console.log(`│ ${name} │ ${installedCell} │ ${authedCell} │`);
  }

  console.log(`└${'─'.repeat(colWidths.name + 2)}┴${'─'.repeat(colWidths.installed + 2)}┴${'─'.repeat(colWidths.authed + 2)}┘`);

  // Instructions for anything not ready
  const broken = results.filter(({ installed, authed }) => !installed || !authed);
  if (broken.length === 0) {
    console.log('\n' + chalk.green('✓ All agents installed and authenticated.\n'));
    return;
  }

  console.log('\n' + chalk.bold('Setup instructions:') + '\n');
  for (const { def, installed, authed } of broken) {
    const info = INSTALL_INSTRUCTIONS[def.id];
    if (!info) continue;

    console.log(chalk.bold(def.name));
    if (!installed) {
      console.log(`  ${chalk.dim('Install:')} ${chalk.cyan(info.install)}`);
    }
    if (!authed) {
      console.log(`  ${chalk.dim('Auth:')}    ${chalk.cyan(info.auth)}`);
    }
    console.log(`  ${chalk.dim('Docs:')}    ${info.docs}`);
    console.log();
  }
}

module.exports = { run };
