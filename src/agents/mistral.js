const { spawn } = require('child_process');
const logger = require('../logger');
const { merged, loadFromDotfiles } = require('../env');

function run(prompt, { unsafe = true } = {}) {
  return new Promise((resolve) => {
    // Mistral Vibe's -p flag always auto-approves — can't run non-interactively without it.
    // Skip in coward mode since we can't honor permission prompts.
    if (!unsafe) {
      return resolve({ success: false, failureType: 'coward_unsupported' });
    }

    // -p enables programmatic mode (auto-approves tools, exits after response)
    const args = ['-p', prompt, '--output', 'text'];

    logger.agentOut('mistral', `spawning: vibe -p <prompt> --output text`);

    const proc = spawn('vibe', args, { env: merged(), stdio: ['ignore', 'pipe', 'pipe'] });
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stderr.write(text);
      logger.write(`[mistral:out] ${text.trim()}`);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logger.write(`[mistral:stderr] ${text.trim()}`);
    });

    proc.on('close', (code) => {
      if (stdout) process.stderr.write('\n');

      if (code === 0 && stdout.trim()) {
        return done({ success: true, output: stdout.trim() });
      }

      const combined = (stdout + stderr).toLowerCase();

      if (combined.includes('429') || combined.includes('rate limit') || combined.includes('too many requests') || combined.includes('quota exceeded')) {
        return done({ success: false, failureType: 'rate_limit' });
      }

      if (combined.includes('econnrefused') || combined.includes('etimedout') || combined.includes('fetch failed') || combined.includes('network error')) {
        return done({ success: false, failureType: 'network' });
      }

      if (combined.includes('invalid api key') || combined.includes('unauthenticated') || combined.includes('401 unauthorized') || combined.includes('no api key')) {
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
    const proc = spawn('vibe', ['--version'], { env: merged() });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function checkAuthed() {
  // Vibe stores the API key in ~/.vibe/.env
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const envFile = path.join(os.homedir(), '.vibe', '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    if (content.includes('MISTRAL_API_KEY')) return true;
  }
  // Fallback: check process env and dotfiles
  if (process.env.MISTRAL_API_KEY) return true;
  const { loadFromDotfiles } = require('../env');
  return !!loadFromDotfiles().MISTRAL_API_KEY;
}

module.exports = { run, checkInstalled, checkAuthed };
