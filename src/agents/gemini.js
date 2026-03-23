const { spawn } = require('child_process');
const logger = require('../logger');

function run(prompt, { unsafe = true } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt];
    if (unsafe) args.push('--yolo');

    logger.agentOut('gemini', `spawning: gemini ${args.slice(1).join(' ')}`);

    const proc = spawn('gemini', args, { env: process.env });
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stderr.write(text);
      logger.write(`[gemini:out] ${text.trim()}`);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger.write(`[gemini:stderr] ${text.trim()}`);
    });

    proc.on('close', (code) => {
      if (stdout) process.stderr.write('\n');

      if (code === 0 && stdout.trim()) {
        return done({ success: true, output: stdout.trim() });
      }

      const combined = (stdout + stderr).toLowerCase();

      if (combined.includes('429') || combined.includes('resource_exhausted') || combined.includes('ratelimitexceeded') || combined.includes('quota') || combined.includes('rate limit') || combined.includes('too many requests') || combined.includes('model_capacity_exhausted')) {
        return done({ success: false, failureType: 'rate_limit' });
      }

      if (combined.includes('econnrefused') || combined.includes('etimedout') || combined.includes('fetch failed') || combined.includes('network error')) {
        return done({ success: false, failureType: 'network' });
      }

      if (combined.includes('unauthenticated') || combined.includes('not logged in') || combined.includes('401 unauthorized') || combined.includes('please login')) {
        return done({ success: false, failureType: 'auth' });
      }

      return done({ success: false, failureType: 'unknown', detail: (stdout + stderr).slice(0, 300) });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        done({ success: false, failureType: 'not_installed' });
      } else {
        done({ success: false, failureType: 'network', detail: err.message });
      }
    });
  });
}

async function checkInstalled() {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['--version'], { env: process.env });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function checkAuthed() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const geminiDir = path.join(os.homedir(), '.gemini');
  if (!fs.existsSync(geminiDir)) return false;
  const files = fs.readdirSync(geminiDir);
  return files.length > 0;
}

module.exports = { run, checkInstalled, checkAuthed };
