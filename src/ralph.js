const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const COMPLETE_MARKER = '<ralph-status>COMPLETE</ralph-status>';
const NETWORK_RETRY_MS = 60 * 1000;       // 1 minute
const EXHAUSTED_RETRY_MS = 30 * 60 * 1000; // 30 minutes

function defaultDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildWorkerPrompt(originalPrompt, contextContent, judgeFeedback) {
  const parts = [
    '<ralph-instructions>',
    'You are working as part of an iterative agentic loop. Follow these rules EVERY turn:',
    '',
    '1. Read <original-prompt> to understand the full task.',
    '2. Read <context> to understand what has already been done.',
    '3. Make meaningful progress on the task.',
    '4. REQUIRED: Before stopping your turn, append a brief summary of what you',
    '   accomplished to miser/ralph/context.md. Write a new dated entry. Do not',
    '   overwrite the file — append to it. This must happen every turn.',
    '5. If ALL tasks in the original prompt are now complete, include exactly this',
    `   text at the very end of your response: ${COMPLETE_MARKER}`,
    '6. If work remains, do NOT include the marker — just stop normally.',
    '</ralph-instructions>',
    '',
    '<original-prompt>',
    originalPrompt,
    '</original-prompt>',
    '',
    '<context>',
    contextContent || '(no previous context — this is the first iteration)',
    '</context>',
  ];

  if (judgeFeedback) {
    parts.push('', '<judge-feedback>', judgeFeedback, '</judge-feedback>');
    parts.push('', 'The judge has reviewed the work and provided the above feedback. Address it before marking complete.');
  }

  return parts.join('\n');
}

function buildJudgePrompt(originalPrompt, requirements) {
  const parts = [
    'You are a code review judge. Carefully review the current state of the codebase',
    'against the original requirements below.',
    '',
    '<original-prompt>',
    originalPrompt,
    '</original-prompt>',
  ];

  if (requirements) {
    parts.push('', '<requirements>', requirements, '</requirements>');
  }

  parts.push(
    '',
    'Your response MUST begin with one of these two lines:',
    '  APPROVED',
    '  REJECTED: <specific actionable feedback>',
    '',
    'If APPROVED: confirm the requirements are fully met.',
    'If REJECTED: be precise about what is missing or wrong so the worker can fix it.',
    'Do not use APPROVED unless every requirement is genuinely satisfied.'
  );

  return parts.join('\n');
}

// ─── State management ─────────────────────────────────────────────────────────

function loadState(statusFile) {
  if (!fs.existsSync(statusFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(statusFile, patch) {
  const current = loadState(statusFile) || {};
  const next = { ...current, ...patch, last_updated: new Date().toISOString() };
  fs.writeFileSync(statusFile, JSON.stringify(next, null, 2));
}

// ─── Main ralph loop ──────────────────────────────────────────────────────────

async function run({
  prompt,
  files = [],
  unsafe = true,
  judge = false,
  judgeAgent = 'claude',
  judgeAgents = null,
  requirementsFile = null,
  // Dependency injection for testing
  agentDefs = null,
  agentImpls = null,
  delay = defaultDelay,
  cwd = process.cwd(),
}) {
  const ralphDir = path.join(cwd, 'miser', 'ralph');
  fs.mkdirSync(ralphDir, { recursive: true });

  const promptFile   = path.join(ralphDir, 'prompt.md');
  const contextFile  = path.join(ralphDir, 'context.md');
  const feedbackFile = path.join(ralphDir, 'judge-feedback.md');
  const statusFile   = path.join(ralphDir, 'status.json');

  // Resolve agent definitions and implementations
  const AGENTS = agentImpls || require('./agents/index');
  const resolvedAgentDefs = agentDefs || (() => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8'));
    return raw.filter((a) => a.enabled && AGENTS[a.id]).sort((a, b) => a.priority - b.priority);
  })();

  // Resolve judge agents hierarchy
  const resolvedJudgeAgents = (() => {
    const judgeIds = judgeAgents || [judgeAgent];
    const allAgents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8'));
    return judgeIds
      .map(id => allAgents.find(a => a.id === id))
      .filter(a => a && a.enabled && AGENTS[a.id])
      .sort((a, b) => a.priority - b.priority);
  })();

  // ── Resume or start fresh ──────────────────────────────────────────────────
  const existingState = loadState(statusFile);
  let iteration = 0;
  let agentStartIndex = 0;
  let resuming = false;

  if (existingState && existingState.status !== 'complete') {
    resuming = true;
    iteration = existingState.iteration || 0;
    agentStartIndex = existingState.agent_index || 0;
    const judgeIndex = existingState.judge_index ?? 0;

    logger.info(`[ralph] Resuming previous session (state: ${existingState.status}, iteration: ${iteration})`);

    // If we were mid-wait, honor the remaining time
    if (existingState.wait_until) {
      const remaining = new Date(existingState.wait_until).getTime() - Date.now();
      if (remaining > 0) {
        const secs = Math.round(remaining / 1000);
        logger.info(`[ralph] Honoring remaining wait: ${secs}s left`);
        await delay(remaining);
      }
      // After exhaustion wait, reset to top of hierarchy
      if (existingState.status === 'waiting_exhausted') {
        agentStartIndex = 0;
      }
    }
  } else {
    // Fresh start
    logger.info(`[ralph] Starting new ralph session`);
    fs.writeFileSync(promptFile, prompt);
    logger.info(`[ralph] Prompt written to: ${promptFile}`);

    // Preserve pre-existing context — never wipe it
    if (fs.existsSync(contextFile)) {
      logger.info(`[ralph] Pre-existing context found at ${contextFile} — preserving`);
    } else {
      fs.writeFileSync(contextFile, '');
      logger.info(`[ralph] Context file initialized: ${contextFile}`);
    }
  }

  writeState(statusFile, {
    status: 'working',
    iteration,
    agent_index: agentStartIndex,
    prompt: prompt.slice(0, 200),
    judge_active: judge,
    judge_agent: judgeAgent,
    judge_agents: judgeAgents || [judgeAgent],
    judge_index: existingState?.judge_index ?? 0,
    started_at: existingState?.started_at || new Date().toISOString(),
  });

  logger.info(`[ralph] Log info — tail the log for real-time updates:`);
  logger.info(`[ralph]   Status: ${statusFile}`);
  logger.info(`[ralph]   Context: ${contextFile}`);

  // ── Main worker loop ───────────────────────────────────────────────────────
  let agentIndex = agentStartIndex;

  while (true) {
    logger.info(`[ralph] ─── Iteration ${iteration + 1} ─── agent start: ${resolvedAgentDefs[agentIndex]?.name || 'top'}`);

    // Build prompt for this iteration
    const contextContent = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, 'utf8') : '';
    const judgeFeedback  = fs.existsSync(feedbackFile) ? fs.readFileSync(feedbackFile, 'utf8') : null;
    const wrappedPrompt  = buildWorkerPrompt(prompt, contextContent, judgeFeedback);

    // Try agents starting from agentIndex
    let success = false;
    let output  = null;

    while (agentIndex < resolvedAgentDefs.length) {
      const agentDef  = resolvedAgentDefs[agentIndex];
      const agentImpl = AGENTS[agentDef.id];
      const pos       = `${agentIndex + 1}/${resolvedAgentDefs.length}`;

      logger.info(`[ralph] Trying ${agentDef.name} (${pos})`);
      writeState(statusFile, { status: 'working', iteration, agent_index: agentIndex });

      // Inner network-retry loop for this agent
      let result;
      while (true) {
        result = await agentImpl.run(wrappedPrompt, { unsafe });

        if (result.failureType === 'network') {
          logger.warn(`[ralph] Network error from ${agentDef.name} — retrying in 1 minute`);
          const waitUntil = new Date(Date.now() + NETWORK_RETRY_MS).toISOString();
          writeState(statusFile, { status: 'waiting_network', iteration, agent_index: agentIndex, wait_until: waitUntil });
          await delay(NETWORK_RETRY_MS);
          writeState(statusFile, { status: 'working', iteration, agent_index: agentIndex, wait_until: null });
          logger.info(`[ralph] Retrying ${agentDef.name} after network wait`);
          continue;
        }
        break;
      }

      if (result.success) {
        success = true;
        output  = result.output;
        logger.success(`[ralph] ${agentDef.name} completed iteration ${iteration + 1}`);
        break;
      }

      logger.warn(`[ralph] ${agentDef.name} failed (${result.failureType}) — trying next agent`);
      agentIndex++;
    }

    if (!success) {
      // All agents exhausted — wait 30 min and restart from top
      logger.warn(`[ralph] All agents exhausted on iteration ${iteration + 1} — waiting 30 minutes`);
      const waitUntil = new Date(Date.now() + EXHAUSTED_RETRY_MS).toISOString();
      writeState(statusFile, { status: 'waiting_exhausted', iteration, agent_index: 0, wait_until: waitUntil });
      await delay(EXHAUSTED_RETRY_MS);
      agentIndex = 0;
      writeState(statusFile, { status: 'working', iteration, agent_index: 0, wait_until: null });
      logger.info(`[ralph] Resuming from top of hierarchy after 30-minute wait`);
      continue;
    }

    // Reset agent index for next iteration
    agentIndex = 0;
    iteration++;
    writeState(statusFile, { status: 'working', iteration, agent_index: 0 });

    // Check completion marker
    const isComplete = output.includes(COMPLETE_MARKER);
    logger.info(`[ralph] Completion check: ${isComplete ? '✓ COMPLETE marker found' : 'no marker, continuing'}`);

    if (!isComplete) continue;

    if (!judge) {
      writeState(statusFile, { status: 'complete', iteration, completed_at: new Date().toISOString() });
      logger.success(`[ralph] Task complete after ${iteration} iteration(s)`);
      return { success: true, iterations: iteration };
    }

    // ── Judge with fallthrough ──────────────────────────────────────────────────
    logger.info(`[ralph] Running judge hierarchy: ${resolvedJudgeAgents.map(j => j.name).join(' → ')}`);
    writeState(statusFile, { status: 'judging', iteration });

    const requirements = requirementsFile && fs.existsSync(requirementsFile)
      ? fs.readFileSync(requirementsFile, 'utf8')
      : null;
    const judgePromptText = buildJudgePrompt(prompt, requirements);

    // Try judges starting from current judgeIndex
    let judgeSuccess = false;
    let judgeResult = null;
    let currentJudgeIndex = existingState?.judge_index ?? 0;

    while (currentJudgeIndex < resolvedJudgeAgents.length) {
      const judgeDef = resolvedJudgeAgents[currentJudgeIndex];
      const judgeImpl = AGENTS[judgeDef.id];
      const pos = `${currentJudgeIndex + 1}/${resolvedJudgeAgents.length}`;

      logger.info(`[ralph] Trying judge ${judgeDef.name} (${pos})`);
      writeState(statusFile, { status: 'judging', iteration, judge_index: currentJudgeIndex });

      // Inner retry loop for this judge
      while (true) {
        judgeResult = await judgeImpl.run(judgePromptText, { unsafe });

        if (judgeResult.failureType === 'network') {
          logger.warn(`[ralph] Judge network error — retrying in 1 minute`);
          const waitUntil = new Date(Date.now() + NETWORK_RETRY_MS).toISOString();
          writeState(statusFile, { status: 'waiting_judge_network', iteration, judge_index: currentJudgeIndex, wait_until: waitUntil });
          await delay(NETWORK_RETRY_MS);
          writeState(statusFile, { status: 'judging', iteration, judge_index: currentJudgeIndex, wait_until: null });
          logger.info(`[ralph] Retrying judge ${judgeDef.name} after network wait`);
          continue;
        }

        if (judgeResult.failureType === 'rate_limit' || judgeResult.failureType === 'auth') {
          logger.warn(`[ralph] Judge ${judgeDef.name} rate limit/auth — falling through to next judge`);
          break; // Fall through to next judge
        }

        if (!judgeResult.success) {
          logger.warn(`[ralph] Judge ${judgeDef.name} failed (${judgeResult.failureType}) — falling through to next judge`);
          break; // Fall through to next judge
        }

        judgeSuccess = true;
        break;
      }

      if (judgeSuccess) break;
      currentJudgeIndex++;
    }

    if (!judgeSuccess) {
      // All judges exhausted — wait 30 min and restart from top
      logger.warn(`[ralph] All judges exhausted — waiting 30 minutes`);
      const waitUntil = new Date(Date.now() + EXHAUSTED_RETRY_MS).toISOString();
      writeState(statusFile, { status: 'waiting_judge_exhausted', iteration, judge_index: 0, wait_until: waitUntil });
      await delay(EXHAUSTED_RETRY_MS);
      currentJudgeIndex = 0;
      writeState(statusFile, { status: 'judging', iteration, judge_index: 0, wait_until: null });
      logger.info(`[ralph] Resuming judge hierarchy from top after 30-minute wait`);
      continue; // Continue main loop to re-judge
    }

    const judgeOutput = judgeResult.output.trim();

    if (judgeOutput.startsWith('APPROVED')) {
      writeState(statusFile, { status: 'complete', iteration, completed_at: new Date().toISOString() });
      logger.success(`[ralph] Judge ${resolvedJudgeAgents[currentJudgeIndex].name} approved — task complete after ${iteration} iteration(s)`);
      return { success: true, iterations: iteration };
    }

    // Rejected — save feedback, loop back, reset judge index
    const feedback = judgeOutput.replace(/^REJECTED:\s*/i, '').trim();
    logger.warn(`[ralph] Judge rejected — feedback saved, looping back`);
    logger.info(`[ralph] Feedback: ${feedback.slice(0, 200)}`);
    fs.writeFileSync(feedbackFile, feedback);
    writeState(statusFile, { status: 'working', iteration, agent_index: 0, judge_index: 0 });
    // Loop continues — COMPLETE marker won't be in new output, keeps going
  }
}

module.exports = { run, buildWorkerPrompt, buildJudgePrompt, COMPLETE_MARKER, NETWORK_RETRY_MS, EXHAUSTED_RETRY_MS };
