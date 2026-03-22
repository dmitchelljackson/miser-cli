const { spawn } = require('child_process');
const logger = require('../logger');

// Qwen Code is a fork of Gemini CLI — same flags apply
function run(prompt, { unsafe = true } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt];
    if (unsafe) args.push('--yolo');

    logger.agentOut('qwen', `spawning: qwen ${args.slice(1).join(' ')}`);

    const proc = spawn('qwen', args, { env: process.env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stderr.write(text);
      logger.write(`[qwen:out] ${text.trim()}`);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger.write(`[qwen:stderr] ${text.trim()}`);
    });

    proc.on('close', (code) => {
      if (stdout) process.stderr.write('\n');

      if (code === 0 && stdout.trim()) {
        return resolve({ success: true, output: stdout.trim() });
      }

      const combined = (stdout + stderr).toLowerCase();

      if (combined.includes('429') || combined.includes('resource_exhausted') || combined.includes('ratelimitexceeded') || combined.includes('quota') || combined.includes('rate limit') || combined.includes('too many requests') || combined.includes('model_capacity_exhausted')) {
        return resolve({ success: false, failureType: 'rate_limit' });
      }

      if (combined.includes('econnrefused') || combined.includes('etimedout') || combined.includes('fetch failed') || combined.includes('network error')) {
        return resolve({ success: false, failureType: 'network' });
      }

      if (combined.includes('unauthenticated') || combined.includes('not logged in') || combined.includes('401 unauthorized') || combined.includes('please login')) {
        return resolve({ success: false, failureType: 'auth' });
      }

      return resolve({ success: false, failureType: 'unknown', detail: (stdout + stderr).slice(0, 300) });
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
    const proc = spawn('qwen', ['--version'], { env: process.env });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function checkAuthed() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  // Qwen Code likely stores auth in ~/.qwen similar to gemini
  const dirs = [
    path.join(os.homedir(), '.qwen'),
    path.join(os.homedir(), '.config', 'qwen'),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return true;
  }
  return false;
}

module.exports = { run, checkInstalled, checkAuthed };
