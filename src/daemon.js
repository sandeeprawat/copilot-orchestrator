// Main daemon loop — the heart of the orchestrator
import { initDB, getNextPendingTasks, claimTask, completeTask, failTask, requeueForRefinement, getRunningCount, getStats } from './taskdb.js';
import { executeTask } from './executor.js';
import { evaluateResult } from './evaluator.js';
import { startInboxWatcher, stopInboxWatcher } from './inbox.js';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'Daemon';

let running = false;
let activeExecutions = new Map(); // taskId -> Promise

export async function startDaemon() {
  initDB();
  running = true;

  // Start inbox watcher
  startInboxWatcher();

  logger.info(COMPONENT, '═══════════════════════════════════════════════');
  logger.info(COMPONENT, '  Copilot Orchestrator started');
  logger.info(COMPONENT, `  Max concurrency: ${config.maxConcurrency}`);
  logger.info(COMPONENT, `  Poll interval: ${config.pollIntervalMs}ms`);
  logger.info(COMPONENT, `  Inbox: ${config.inboxDir}`);
  logger.info(COMPONENT, `  Database: ${config.dbPath}`);
  logger.info(COMPONENT, '═══════════════════════════════════════════════');

  // Graceful shutdown
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Main poll loop
  while (running) {
    try {
      await tick();
    } catch (e) {
      logger.error(COMPONENT, `Tick error: ${e.message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

async function tick() {
  const runningCount = getRunningCount();
  const slots = config.maxConcurrency - runningCount;

  if (slots <= 0) return;

  const tasks = getNextPendingTasks(slots);
  if (tasks.length === 0) return;

  logger.info(COMPONENT, `Dispatching ${tasks.length} task(s) (${runningCount} running, ${slots} slots)`);

  for (const task of tasks) {
    if (!claimTask(task.id)) continue;

    // Fire and forget — runs in background
    const execution = processTask(task);
    activeExecutions.set(task.id, execution);
    execution.finally(() => activeExecutions.delete(task.id));
  }
}

async function processTask(task) {
  const taskId = task.id;

  try {
    logger.info(COMPONENT, `▶ Starting task ${taskId}`, taskId);

    // Execute via copilot
    const execResult = await executeTask(task);

    if (!execResult.success) {
      logger.error(COMPONENT, `✗ Task ${taskId} failed: ${execResult.error}`, taskId);
      failTask(taskId, execResult.error);
      return;
    }

    logger.info(COMPONENT, `✓ Task ${taskId} execution completed`, taskId);

    // Evaluate result
    const evaluation = await evaluateResult(task, execResult.result);

    if (evaluation.passed) {
      logger.info(COMPONENT, `★ Task ${taskId} passed evaluation (score: ${evaluation.score ?? 'N/A'})`, taskId);
      completeTask(taskId, {
        result: execResult.result,
        score: evaluation.score,
        evaluation: JSON.stringify(evaluation),
        sessionFile: execResult.sessionFile,
      });
    } else {
      // Re-queue for refinement with full context
      logger.info(COMPONENT, `↻ Task ${taskId} needs refinement (score: ${evaluation.score})`, taskId);

      // Build a context-rich refinement prompt so the next agent knows what was done
      const refinedPrompt = config.refinementPromptTemplate
        .replace('{{ORIGINAL_PROMPT}}', task.original_prompt || task.prompt)
        .replace('{{PREVIOUS_RESULT}}', (execResult.result || '').slice(0, 6000))
        .replace('{{SCORE}}', evaluation.score ?? '?')
        .replace('{{REASONING}}', evaluation.reasoning || 'No details')
        .replace('{{GAPS}}', (evaluation.gaps || []).map((g, i) => `${i + 1}. ${g}`).join('\n') || 'None specified');

      completeTask(taskId, {
        result: execResult.result,
        score: evaluation.score,
        evaluation: JSON.stringify(evaluation),
        sessionFile: execResult.sessionFile,
      });

      const newId = requeueForRefinement(taskId, refinedPrompt);
      if (newId) {
        logger.info(COMPONENT, `↻ Refinement task created: ${newId} (carries forward previous result + feedback)`, newId);
      }
    }
  } catch (e) {
    logger.error(COMPONENT, `✗ Task ${taskId} unexpected error: ${e.message}`, taskId);
    failTask(taskId, e.message);
  }
}

async function shutdown(signal) {
  logger.info(COMPONENT, `\n${signal} received. Shutting down gracefully...`);
  running = false;
  stopInboxWatcher();

  // Wait for active executions
  if (activeExecutions.size > 0) {
    logger.info(COMPONENT, `Waiting for ${activeExecutions.size} active task(s) to finish...`);
    await Promise.allSettled(activeExecutions.values());
  }

  logger.info(COMPONENT, 'Orchestrator stopped.');
  process.exit(0);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function stopDaemon() {
  running = false;
}
