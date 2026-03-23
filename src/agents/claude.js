const { spawn } = require('child_process');
const logger = require('../logger');

// Exit states
// success    → { success: true, output }
// rate_limit → { success: false, failureType: 'rate_limit' }
// network    → { success: false, failureType: 'network' }

function run(prompt, { unsafe = true } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (unsafe) args.push('--dangerously-skip-permissions');

    logger.agentOut('claude', `spawning: claude ${args.slice(2).join(' ')}`);

    const proc = spawn('claude', args, { env: process.env });

    let result = null;
    let failureType = null;
    let stderr = '';
    let textBuffer = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        logger.write(`[claude:raw] ${line}`);
        try {
          const event = JSON.parse(line);

          // Final result
          if (event.type === 'result' && event.subtype === 'success') {
            result = event.result;
          }

          // Collect assistant text for real-time display
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                const newText = block.text.slice(textBuffer.length);
                if (newText) {
                  process.stderr.write(newText);
                  textBuffer = block.text;
                }
              }
            }
          }

          // API error events — kill the process immediately so we fall through
          // to the next agent rather than blocking forever on Claude's internal retries
          if (event.type === 'system' && event.subtype === 'api_retry') {
            const err = event.error;
            if (err === 'rate_limit' || err === 'billing_error') {
              failureType = 'rate_limit';
              logger.agentOut('claude', `api error: ${err} — killing and falling through`);
              proc.kill();
            } else {
              failureType = 'network';
              logger.agentOut('claude', `api error: ${err} — killing and falling through`);
              proc.kill();
            }
          }
        } catch {
          // non-JSON line, log it
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger.write(`[claude:stderr] ${text.trim()}`);
    });

    proc.on('close', (code) => {
      if (textBuffer) process.stderr.write('\n');

      if (result !== null) {
        return resolve({ success: true, output: result });
      }

      if (failureType === 'rate_limit') {
        return resolve({ success: false, failureType: 'rate_limit' });
      }

      // Try to distinguish network vs other failure from stderr
      const isNetwork =
        stderr.includes('ECONNREFUSED') ||
        stderr.includes('ETIMEDOUT') ||
        stderr.includes('network') ||
        stderr.includes('fetch failed');

      if (isNetwork) {
        return resolve({ success: false, failureType: 'network' });
      }

      // auth error
      if (stderr.includes('authentication') || stderr.includes('401') || stderr.includes('not logged in')) {
        return resolve({ success: false, failureType: 'auth' });
      }

      return resolve({ success: false, failureType: 'unknown', detail: stderr.slice(0, 300) });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        resolve({ success: false, failureType: 'not_installed' });
      } else {
        resolve({ success: false, failureType: 'network', detail: err.message });
      }
    });
  });
}

async function checkInstalled() {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], { env: process.env });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function checkAuthed() {
  // Check for claude auth file
  const os = require('os');
  const fs = require('fs');
  const credPaths = [
    require('path').join(os.homedir(), '.claude', '.credentials.json'),
    require('path').join(os.homedir(), '.claude', 'auth.json'),
  ];
  for (const p of credPaths) {
    if (fs.existsSync(p)) return true;
  }
  // Fall back to checking if claude config dir has any files
  const claudeDir = require('path').join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) {
    const files = fs.readdirSync(claudeDir);
    if (files.length > 0) return true;
  }
  return false;
}

module.exports = { run, checkInstalled, checkAuthed };
