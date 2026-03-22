const fs = require('fs');
const path = require('path');
const os = require('os');

// Read exported env vars from common shell dotfiles.
// Handles: export FOO=bar, export FOO="bar", export FOO='bar'
function loadFromDotfiles() {
  const files = [
    '.zshrc', '.zprofile', '.bash_profile', '.bashrc', '.profile',
  ].map((f) => path.join(os.homedir(), f));

  const env = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const [, key, val] of content.matchAll(/^export\s+(\w+)=["']?([^"'\n#]+?)["']?\s*$/gm)) {
      env[key.trim()] = val.trim();
    }
  }
  return env;
}

// Merge process.env with any vars found in dotfiles (process.env wins).
function merged() {
  return { ...loadFromDotfiles(), ...process.env };
}

module.exports = { loadFromDotfiles, merged };
