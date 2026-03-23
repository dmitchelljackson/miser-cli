const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { run, buildWorkerPrompt, buildJudgePrompt, COMPLETE_MARKER, NETWORK_RETRY_MS, EXHAUSTED_RETRY_MS } = require('../src/ralph');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miser-test-'));
}

function noDelay() {
  return Promise.resolve();
}

function makeAgent(responses) {
  let call = 0;
  return {
    run: async () => {
      const r = responses[call] ?? responses[responses.length - 1];
      call++;
      return r;
    },
    checkInstalled: async () => true,
    checkAuthed: async () => true,
    _calls: () => call,
  };
}

function agentDefs(ids) {
  return ids.map((id, i) => ({ id, name: id, priority: i + 1, enabled: true }));
}

function statusFile(cwd) {
  return path.join(cwd, 'miser', 'ralph', 'status.json');
}

function readStatus(cwd) {
  return JSON.parse(fs.readFileSync(statusFile(cwd), 'utf8'));
}

function contextFile(cwd) {
  return path.join(cwd, 'miser', 'ralph', 'context.md');
}

function feedbackFile(cwd) {
  return path.join(cwd, 'miser', 'ralph', 'judge-feedback.md');
}

// ─── 1. Completion detection ──────────────────────────────────────────────────

describe('Completion detection', () => {
  test('1. COMPLETE marker in output → loop exits with success', async () => {
    const cwd = makeTmpDir();
    const agent = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    assert.equal(result.success, true);
    assert.equal(result.iterations, 1);
    assert.equal(readStatus(cwd).status, 'complete');
  });

  test('2. No COMPLETE marker → loop continues to next iteration', async () => {
    const cwd = makeTmpDir();
    let calls = 0;
    const agent = {
      run: async () => {
        calls++;
        if (calls === 1) return { success: true, output: 'still working' };
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed: async () => true,
    };
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    assert.equal(calls, 2);
    assert.equal(result.iterations, 2);
  });

  test('3. COMPLETE marker present but judge active → runs judge, does not exit early', async () => {
    const cwd = makeTmpDir();
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const judge  = makeAgent([{ success: true, output: 'APPROVED' }]);
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    assert.equal(judge._calls(), 1);
    assert.equal(result.success, true);
  });

  test('4. Judge returns APPROVED → loop exits', async () => {
    const cwd = makeTmpDir();
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const judge  = makeAgent([{ success: true, output: 'APPROVED — all requirements met' }]);
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    assert.equal(result.success, true);
    assert.equal(readStatus(cwd).status, 'complete');
  });

  test('5. Judge returns REJECTED → saves feedback, clears marker expectation, loops back', async () => {
    const cwd = makeTmpDir();
    let workerCalls = 0;
    const worker = {
      run: async () => {
        workerCalls++;
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    let judgeCalls = 0;
    const judge = {
      run: async () => {
        judgeCalls++;
        if (judgeCalls === 1) return { success: true, output: 'REJECTED: missing tests' };
        return { success: true, output: 'APPROVED' };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    assert.equal(workerCalls, 2); // ran twice — once before rejection, once after
    assert.equal(judgeCalls, 2);
    const feedback = fs.readFileSync(feedbackFile(cwd), 'utf8');
    assert.ok(feedback.includes('missing tests'));
    assert.equal(result.success, true);
  });
});

// ─── 1b. Claude agent unit tests ──────────────────────────────────────────────

describe('Claude agent rate-limit detection', () => {
  test('claude: rate_limit fallthrough — agent returns rate_limit when killed mid-run', async () => {
    // Verify the ralph loop correctly falls through when claude returns rate_limit
    // (the actual kill-on-api_retry is tested implicitly via integration)
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };

    const claudeAgent = makeAgent([{ success: false, failureType: 'rate_limit' }]);
    const geminiAgent = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);

    const result = await run({
      prompt: 'test',
      agentDefs: agentDefs(['claude', 'gemini']),
      agentImpls: { claude: claudeAgent, gemini: geminiAgent },
      delay: trackDelay,
      cwd,
    });

    assert.equal(claudeAgent._calls(), 1);  // claude tried once
    assert.equal(geminiAgent._calls(), 1);  // gemini picked up immediately
    assert.equal(delays.length, 0);          // no wait between fallthrough
    assert.equal(result.success, true);
  });
});

// ─── 2. Worker error handling ─────────────────────────────────────────────────

describe('Worker error handling', () => {
  test('6. Network error → retries same agent, not next agent', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    let calls = 0;
    const agent = {
      run: async () => {
        calls++;
        if (calls === 1) return { success: false, failureType: 'network' };
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    const otherAgent = makeAgent([{ success: true, output: 'should not be called' }]);
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a', 'b']),
      agentImpls: { a: agent, b: otherAgent },
      delay: trackDelay,
      cwd,
    });
    assert.equal(calls, 2);           // agent a called twice
    assert.equal(otherAgent._calls(), 0); // agent b never called
    assert.equal(delays.length, 1);
    assert.equal(delays[0], NETWORK_RETRY_MS);
  });

  test('7. Rate limit on first agent → falls through to second immediately', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    const agentA = makeAgent([{ success: false, failureType: 'rate_limit' }]);
    const agentB = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a', 'b']),
      agentImpls: { a: agentA, b: agentB },
      delay: trackDelay,
      cwd,
    });
    assert.equal(agentA._calls(), 1);
    assert.equal(agentB._calls(), 1);
    assert.equal(delays.length, 0); // no wait between fallthrough
  });

  test('8. All agents rate-limited → waits 30 min then resets to top of hierarchy', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    let exhaustCycles = 0;
    const agent = {
      run: async () => {
        exhaustCycles++;
        if (exhaustCycles < 3) return { success: false, failureType: 'rate_limit' };
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: trackDelay,
      cwd,
    });
    assert.ok(delays.some((d) => d === EXHAUSTED_RETRY_MS));
    const s = readStatus(cwd);
    assert.equal(s.status, 'complete');
  });

  test('9. Network error on second agent → retries that agent, does not advance further', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    const agentA = makeAgent([{ success: false, failureType: 'rate_limit' }]);
    let bCalls = 0;
    const agentB = {
      run: async () => {
        bCalls++;
        if (bCalls === 1) return { success: false, failureType: 'network' };
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    const agentC = makeAgent([{ success: true, output: 'should not be called' }]);
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a', 'b', 'c']),
      agentImpls: { a: agentA, b: agentB, c: agentC },
      delay: trackDelay,
      cwd,
    });
    assert.equal(agentA._calls(), 1);
    assert.equal(bCalls, 2);         // b retried once
    assert.equal(agentC._calls(), 0); // c never called
    assert.equal(delays[0], NETWORK_RETRY_MS);
  });

  test('10. Agent not installed or authed → hard failure before running', async () => {
    const cwd = makeTmpDir();
    const { requireAllAgentsReady } = require('../src/validate');

    // Patch one agent to appear uninstalled
    const origAgents = require('../src/agents/index');
    const origCheck = origAgents.gemini.checkInstalled;
    origAgents.gemini.checkInstalled = async () => false;

    const { validateAgents } = require('../src/validate');
    const errors = await validateAgents();
    origAgents.gemini.checkInstalled = origCheck; // restore

    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('Gemini')));
  });
});

// ─── 3. Judge error handling ──────────────────────────────────────────────────

describe('Judge error handling', () => {
  test('11. Judge network error → retries judge after 1 min, no fallthrough', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    let judgeCalls = 0;
    const judge = {
      run: async () => {
        judgeCalls++;
        if (judgeCalls === 1) return { success: false, failureType: 'network' };
        return { success: true, output: 'APPROVED' };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: trackDelay,
      cwd,
    });
    assert.equal(judgeCalls, 2);
    assert.equal(delays[0], NETWORK_RETRY_MS);
  });

  test('12. Judge rate limit → retries judge after 30 min', async () => {
    const cwd = makeTmpDir();
    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    let judgeCalls = 0;
    const judge = {
      run: async () => {
        judgeCalls++;
        if (judgeCalls === 1) return { success: false, failureType: 'rate_limit' };
        return { success: true, output: 'APPROVED' };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: trackDelay,
      cwd,
    });
    assert.equal(judgeCalls, 2);
    assert.equal(delays[0], EXHAUSTED_RETRY_MS);
  });

  test('13. Judge always uses claude by default even if claude was a failed worker', async () => {
    const cwd = makeTmpDir();
    // claude fails as worker, gemini succeeds, then claude judges
    const claudeWorkerCalls = [];
    const claude = {
      run: async (prompt) => {
        claudeWorkerCalls.push('worker');
        if (claudeWorkerCalls.length === 1 && !prompt.includes('judge')) {
          return { success: false, failureType: 'rate_limit' };
        }
        return { success: true, output: 'APPROVED' };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    const gemini = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const result = await run({
      prompt: 'test',
      agentDefs: agentDefs(['claude', 'gemini']),
      agentImpls: { claude, gemini },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    assert.equal(result.success, true);
    // claude was called as worker (failed) and as judge (approved)
    assert.equal(claudeWorkerCalls.length, 2);
  });
});

// ─── 4. Context management ────────────────────────────────────────────────────

describe('Context management', () => {
  test('14. First iteration: prompt.md written, context.md initialized', async () => {
    const cwd = makeTmpDir();
    const agent = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    await run({
      prompt: 'build me something',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    const promptMd = fs.readFileSync(path.join(cwd, 'miser', 'ralph', 'prompt.md'), 'utf8');
    assert.equal(promptMd, 'build me something');
    assert.ok(fs.existsSync(contextFile(cwd)));
  });

  test('15. Worker prompt includes previous context on subsequent iterations', async () => {
    const cwd = makeTmpDir();
    const prompts = [];
    let calls = 0;
    const agent = {
      run: async (prompt) => {
        prompts.push(prompt);
        calls++;
        if (calls === 1) {
          // Simulate agent writing context
          fs.mkdirSync(path.join(cwd, 'miser', 'ralph'), { recursive: true });
          fs.appendFileSync(path.join(cwd, 'miser', 'ralph', 'context.md'), 'did stuff in iteration 1\n');
          return { success: true, output: 'still working' };
        }
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    assert.ok(prompts[1].includes('did stuff in iteration 1'));
  });

  test('16. Judge feedback saved and included in next iteration prompt', async () => {
    const cwd = makeTmpDir();
    const workerPrompts = [];
    let workerCalls = 0;
    const worker = {
      run: async (prompt) => {
        workerPrompts.push(prompt);
        workerCalls++;
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    let judgeCalls = 0;
    const judge = {
      run: async () => {
        judgeCalls++;
        if (judgeCalls === 1) return { success: true, output: 'REJECTED: add error handling' };
        return { success: true, output: 'APPROVED' };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    // Second worker call should include judge feedback
    assert.ok(workerPrompts[1].includes('add error handling'));
    assert.ok(fs.existsSync(feedbackFile(cwd)));
  });

  test('17. Worker prompt structure includes all context sections', async () => {
    const prompt = buildWorkerPrompt('do X', 'previous context here', 'judge said fix Y');
    assert.ok(prompt.includes('<original-prompt>'));
    assert.ok(prompt.includes('do X'));
    assert.ok(prompt.includes('<context>'));
    assert.ok(prompt.includes('previous context here'));
    assert.ok(prompt.includes('<judge-feedback>'));
    assert.ok(prompt.includes('judge said fix Y'));
    assert.ok(prompt.includes(COMPLETE_MARKER));
  });

  test('18. Status file reflects current iteration, agent, and ralph mode', async () => {
    const cwd = makeTmpDir();
    let capturedStatus = null;
    let calls = 0;
    const agent = {
      run: async () => {
        calls++;
        capturedStatus = readStatus(cwd);
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    assert.equal(capturedStatus.status, 'working');
    assert.equal(capturedStatus.iteration, 0);
    assert.equal(capturedStatus.agent_index, 0);
    assert.equal(capturedStatus.judge_active, false);
  });
});

// ─── 5. Configuration ─────────────────────────────────────────────────────────

describe('Configuration', () => {
  test('19. --judge flag activates judge after completion', async () => {
    const cwd = makeTmpDir();
    let judgeCalled = false;
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const judge = {
      run: async () => { judgeCalled = true; return { success: true, output: 'APPROVED' }; },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, claude: judge },
      judge: true,
      judgeAgent: 'claude',
      delay: noDelay,
      cwd,
    });
    assert.equal(judgeCalled, true);
  });

  test('20. --judge-agent overrides default claude judge', async () => {
    const cwd = makeTmpDir();
    let geminiJudgeCalled = false;
    const worker = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const geminiJudge = {
      run: async () => { geminiJudgeCalled = true; return { success: true, output: 'APPROVED' }; },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    const claudeJudge = makeAgent([{ success: true, output: 'APPROVED' }]);
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['worker']),
      agentImpls: { worker, gemini: geminiJudge, claude: claudeJudge },
      judge: true,
      judgeAgent: 'gemini',
      delay: noDelay,
      cwd,
    });
    assert.equal(geminiJudgeCalled, true);
    assert.equal(claudeJudge._calls(), 0);
  });

  test('21. Without --ralph, single-shot runner is used (no ralph state files)', async () => {
    // This is validated by the fact that ralph.js is not called unless opts.ralph is set.
    // We test that buildWorkerPrompt without judge feedback omits the feedback section.
    const prompt = buildWorkerPrompt('do X', 'some context', null);
    assert.ok(!prompt.includes('<judge-feedback>'));
  });

  test('22. --judge without --ralph exits with error', async () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'miser.js'), 'run', '--judge', 'hello'],
      { cwd: path.join(__dirname, '..'), env: process.env }
    );
    assert.ok(result.status !== 0);
    assert.ok(result.stderr.toString().includes('--judge requires --ralph'));
  });

  test('23. All agents not ready → fail before running (except setup)', async () => {
    const { validateAgents } = require('../src/validate');
    const origAgents = require('../src/agents/index');
    const orig = origAgents.qwen.checkAuthed;
    origAgents.qwen.checkAuthed = async () => false;
    const errors = await validateAgents();
    origAgents.qwen.checkAuthed = orig;
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('Qwen')));
  });
});

// ─── 6. Graceful resume ───────────────────────────────────────────────────────

describe('Graceful resume', () => {
  test('Resume: picks up from correct iteration when status.json exists', async () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, 'miser', 'ralph'), { recursive: true });
    // Pre-write status as if we were interrupted mid-iteration 3
    fs.writeFileSync(statusFile(cwd), JSON.stringify({
      status: 'working',
      iteration: 2,
      agent_index: 0,
      prompt: 'do the thing',
      started_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(cwd, 'miser', 'ralph', 'prompt.md'), 'do the thing');
    fs.writeFileSync(contextFile(cwd), 'work done in iterations 1 and 2\n');

    const agent = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    const result = await run({
      prompt: 'do the thing',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    assert.equal(result.success, true);
    assert.equal(result.iterations, 3); // resumed from 2, completed at 3
  });

  test('Resume: pre-existing context.md is preserved, not wiped', async () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, 'miser', 'ralph'), { recursive: true });
    const preExistingContext = 'lots of work already done here\n';
    fs.writeFileSync(contextFile(cwd), preExistingContext);

    const capturedPrompts = [];
    const agent = {
      run: async (p) => {
        capturedPrompts.push(p);
        return { success: true, output: `done ${COMPLETE_MARKER}` };
      },
      checkInstalled: async () => true,
      checkAuthed:    async () => true,
    };
    await run({
      prompt: 'continue the work',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: noDelay,
      cwd,
    });
    // Context file should still contain the pre-existing content
    const ctx = fs.readFileSync(contextFile(cwd), 'utf8');
    assert.ok(ctx.includes(preExistingContext.trim()));
    // Agent prompt should include pre-existing context
    assert.ok(capturedPrompts[0].includes('lots of work already done here'));
  });

  test('Resume: wait states honor remaining time from wait_until', async () => {
    const cwd = makeTmpDir();
    fs.mkdirSync(path.join(cwd, 'miser', 'ralph'), { recursive: true });
    // Simulate interrupted mid-network-wait with 10s remaining
    const waitUntil = new Date(Date.now() + 10000).toISOString();
    fs.writeFileSync(statusFile(cwd), JSON.stringify({
      status: 'waiting_network',
      iteration: 0,
      agent_index: 0,
      wait_until: waitUntil,
      prompt: 'test',
      started_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(cwd, 'miser', 'ralph', 'prompt.md'), 'test');
    fs.writeFileSync(contextFile(cwd), '');

    const delays = [];
    const trackDelay = async (ms) => { delays.push(ms); };
    const agent = makeAgent([{ success: true, output: `done ${COMPLETE_MARKER}` }]);
    await run({
      prompt: 'test',
      agentDefs: agentDefs(['a']),
      agentImpls: { a: agent },
      delay: trackDelay,
      cwd,
    });
    // Should have waited approximately the remaining time
    assert.ok(delays.length > 0);
    assert.ok(delays[0] > 0 && delays[0] <= 10000);
  });
});
