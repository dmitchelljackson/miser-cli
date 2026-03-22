const claude = require('./claude');
const gemini = require('./gemini');
const qwen = require('./qwen');
const mistral = require('./mistral');

const AGENTS = {
  claude,
  gemini,
  qwen,
  mistral,
};

module.exports = AGENTS;
