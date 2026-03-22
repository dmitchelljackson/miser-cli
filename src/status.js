const fs = require('fs');
const path = require('path');

let statusFile = null;
let state = null;

function init(cwd, prompt) {
  const dir = path.join(cwd, 'miser');
  fs.mkdirSync(dir, { recursive: true });
  statusFile = path.join(dir, 'status.json');
  state = {
    status: 'running',
    current_agent: null,
    satisfied_by: null,
    prompt: prompt.length > 200 ? prompt.slice(0, 200) + '...' : prompt,
    started_at: new Date().toISOString(),
    completed_at: null,
    attempts: [],
  };
  flush();
}

function setAgent(agentId) {
  state.current_agent = agentId;
  flush();
}

function recordAttempt(agentId, status, reason = null) {
  state.attempts.push({
    agent: agentId,
    status,
    reason,
    at: new Date().toISOString(),
  });
  flush();
}

function complete(agentId) {
  state.status = 'completed';
  state.current_agent = null;
  state.satisfied_by = agentId;
  state.completed_at = new Date().toISOString();
  flush();
}

function exhaust() {
  state.status = 'exhausted';
  state.current_agent = null;
  state.completed_at = new Date().toISOString();
  flush();
}

function networkError(agentId) {
  state.status = 'network_error';
  state.current_agent = null;
  state.completed_at = new Date().toISOString();
  recordAttempt(agentId, 'network_error');
  flush();
}

function flush() {
  if (statusFile) {
    fs.writeFileSync(statusFile, JSON.stringify(state, null, 2));
  }
}

module.exports = { init, setAgent, recordAttempt, complete, exhaust, networkError };
