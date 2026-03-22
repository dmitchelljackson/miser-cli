const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

let logFile = null;
let logDir = null;

function init(cwd) {
  logDir = path.join(cwd, 'miser');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'miser.log');
  // Start fresh log for this invocation
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] miser invoked\n`);
}

function getLogInfo(cwd) {
  const statusPath = path.join(cwd, 'miser', 'status.json');
  const logPath = path.join(cwd, 'miser', 'miser.log');
  return [
    chalk.dim('─'.repeat(60)),
    `${chalk.bold('[miser]')} Status file: ${chalk.cyan(statusPath)}`,
    `${chalk.bold('[miser]')} Log file:    ${chalk.cyan(logPath)}`,
    `${chalk.bold('[miser]')} Tail logs:   ${chalk.cyan(`tail -f ${logPath}`)}`,
    chalk.dim('─'.repeat(60)),
  ].join('\n');
}

function write(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (logFile) fs.appendFileSync(logFile, line);
}

function info(message) {
  const line = `[miser] ${message}`;
  console.error(chalk.bold('[miser]') + ' ' + message);
  write(line);
}

function agentOut(agentId, message) {
  const line = `[${agentId}] ${message}`;
  process.stderr.write(chalk.dim(`[${agentId}]`) + ' ' + message + '\n');
  write(line);
}

function success(message) {
  console.error(chalk.green('✓') + ' ' + chalk.bold('[miser]') + ' ' + message);
  write(`[success] ${message}`);
}

function warn(message) {
  console.error(chalk.yellow('⚠') + ' ' + chalk.bold('[miser]') + ' ' + message);
  write(`[warn] ${message}`);
}

function error(message) {
  console.error(chalk.red('✗') + ' ' + chalk.bold('[miser]') + ' ' + message);
  write(`[error] ${message}`);
}

module.exports = { init, getLogInfo, info, agentOut, success, warn, error, write };
