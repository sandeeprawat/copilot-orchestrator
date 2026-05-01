// Agent Runtime — refactored agentic loop with event-driven lifecycle
import { EventEmitter } from 'events';
import { resolve } from 'path';
import {
  initDB, addTask, getNextPendingTasks, claimTask, completeTask,
  failTask, requeueForRefinement, getRunningCount,
  getStats as getTaskStats, getTask as getTaskById, listTasks as listAllTasks,
} from '../taskdb.js';
import { executeTask } from '../executor.js';
import { evaluateResult } from '../evaluator.js';
import { buildSystemPrompt, loadSoul } from '../agents/system-prompt.js';
import { search as memorySearch, save as memorySave, getContext as getMemoryContext } from '../memory/index.js';
import { loadSkills, getSkillCatalog } from '../skills/registry.js';
import { initSessions, getOrCreateSession, addToHistory, getSessionContext } from '../sessions/manager.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'Runtime';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Factory that creates an agent runtime object.
 * @param {object} runtimeConfig — merged configuration
 * @returns {object} runtime with start/stop/submitTask/getTask/listTasks/getStats/cancelTask + EventEmitter
 */
export function createAgentRuntime(runtimeConfig = config) {
  const emitter = new EventEmitter();
  let running = false;
  let pollTimer = null;
  const activeExecutions = new Map(); // taskId -> Promise

  // ── Helpers ──────────────────────────────────────────────────────────

  async function initSubsystems() {
    initDB();

    // Resume tasks that were running when we last shut down
    try {
      const db = (await import('../taskdb.js')).getDB();
      const stuck = db.prepare(`UPDATE tasks SET status = 'pending', started_at = NULL WHERE status = 'running'`).run();
      if (stuck.changes > 0) {
        logger.info(COMPONENT, `Resumed ${stuck.changes} interrupted task(s) from previous run`);
      }
    } catch (e) {
      logger.warn(COMPONENT, `Failed to resume tasks: ${e.message}`);
    }

    try { await loadSkills(); } catch (e) {
      logger.warn(COMPONENT, `Skills not loaded: ${e.message}`);
    }

    try { initSessions(); } catch (e) {
      logger.warn(COMPONENT, `Sessions not initialized: ${e.message}`);
    }

    try { loadSoul(); } catch (e) {
      logger.warn(COMPONENT, `Soul not loaded: ${e.message}`);
    }
  }

  // ── Task processing ─────────────────────────────────────────────────

  async function processTask(task) {
    const taskId = task.id;

    try {
      emitter.emit('task-started', { taskId, task });
      logger.info(COMPONENT, `▶ Starting task ${taskId}`, taskId);

      // Determine output file for this task
      const outputFile = `output-${taskId}.md`;
      const outputPath = resolve(task.workdir || runtimeConfig.ROOT, outputFile);

      // Build enriched prompt with system context
      let systemPrompt = '';
      try {
        const memCtx = getMemoryContext(task.prompt);
        const skillCatalog = getSkillCatalog();
        const session = getOrCreateSession(`task:${taskId}`, task.workdir);
        const sessionCtx = getSessionContext(session.id);

        systemPrompt = buildSystemPrompt({
          memoryContext: memCtx,
          skillCatalog,
          sessionContext: sessionCtx?.context || '',
          outputFile,
        });
      } catch (e) {
        logger.debug(COMPONENT, `System prompt enrichment skipped: ${e.message}`, taskId);
      }

      // Compose the final prompt
      const enrichedTask = { ...task, outputFile: outputPath };
      if (systemPrompt) {
        enrichedTask.prompt = systemPrompt + '\n\n' + task.prompt;
      }

      // Execute via copilot
      const execResult = await executeTask(enrichedTask);

      if (!execResult.success) {
        logger.error(COMPONENT, `✗ Task ${taskId} failed: ${execResult.error}`, taskId);
        failTask(taskId, execResult.error);
        emitter.emit('task-failed', { taskId, error: execResult.error });
        return;
      }

      logger.info(COMPONENT, `✓ Task ${taskId} execution completed`, taskId);

      // Save relevant facts to memory
      if (runtimeConfig.autoSaveMemory && execResult.result) {
        try {
          memorySave(
            'tasks',
            `Task: ${(task.original_prompt || task.prompt).slice(0, 200)}\nResult: ${execResult.result.slice(0, 1000)}`,
            `Task ${taskId}`
          );
        } catch (e) {
          logger.debug(COMPONENT, `Memory save skipped: ${e.message}`, taskId);
        }
      }

      // Record in session history
      try {
        const session = getOrCreateSession(`task:${taskId}`, task.workdir);
        addToHistory(session.id, 'user', task.original_prompt || task.prompt);
        addToHistory(session.id, 'assistant', (execResult.result || '').slice(0, 4000));
      } catch (e) {
        logger.debug(COMPONENT, `Session history skipped: ${e.message}`, taskId);
      }

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
        emitter.emit('task-completed', {
          taskId,
          result: execResult.result,
          score: evaluation.score,
          outputFile: outputPath,
        });
      } else {
        // Re-queue for refinement with full context
        logger.info(COMPONENT, `↻ Task ${taskId} needs refinement (score: ${evaluation.score})`, taskId);

        const refinedPrompt = runtimeConfig.refinementPromptTemplate
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
          logger.info(COMPONENT, `↻ Refinement task created: ${newId}`, newId);
          emitter.emit('task-refinement', { taskId, newTaskId: newId, score: evaluation.score });
        }
      }
    } catch (e) {
      logger.error(COMPONENT, `✗ Task ${taskId} unexpected error: ${e.message}`, taskId);
      failTask(taskId, e.message);
      emitter.emit('task-failed', { taskId, error: e.message });
    }
  }

  // ── Poll loop ───────────────────────────────────────────────────────

  async function tick() {
    const runningCount = getRunningCount();
    const slots = runtimeConfig.maxConcurrency - runningCount;

    if (slots <= 0) return;

    const tasks = getNextPendingTasks(slots);
    if (tasks.length === 0) return;

    logger.info(COMPONENT, `Dispatching ${tasks.length} task(s) (${runningCount} running, ${slots} slots)`);

    for (const task of tasks) {
      if (!claimTask(task.id)) continue;

      const execution = processTask(task);
      activeExecutions.set(task.id, execution);
      execution.finally(() => activeExecutions.delete(task.id));
    }
  }

  async function pollLoop() {
    while (running) {
      try {
        await tick();
      } catch (e) {
        logger.error(COMPONENT, `Tick error: ${e.message}`);
      }
      await sleep(runtimeConfig.pollIntervalMs);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const runtime = {
    /** Start the runtime — initializes subsystems and begins polling. */
    async start() {
      await initSubsystems();
      running = true;

      logger.info(COMPONENT, 'Agent runtime started');
      logger.info(COMPONENT, `  Max concurrency: ${runtimeConfig.maxConcurrency}`);
      logger.info(COMPONENT, `  Poll interval: ${runtimeConfig.pollIntervalMs}ms`);
      logger.info(COMPONENT, `  Database: ${runtimeConfig.dbPath}`);

      // Start polling in background (non-blocking)
      pollLoop();
    },

    /** Graceful shutdown — waits for active tasks to finish. */
    async stop() {
      logger.info(COMPONENT, 'Stopping agent runtime...');
      running = false;

      if (activeExecutions.size > 0) {
        logger.info(COMPONENT, `Waiting for ${activeExecutions.size} active task(s)...`);
        await Promise.allSettled(activeExecutions.values());
      }

      logger.info(COMPONENT, 'Agent runtime stopped.');
    },

    /** Submit a task to the queue. Returns taskId. */
    submitTask(taskDef) {
      const taskId = addTask({
        prompt: taskDef.prompt,
        workdir: taskDef.workdir || null,
        priority: taskDef.priority || 5,
        maxRefinements: taskDef.maxRefinements ?? runtimeConfig.maxRefinements,
        timeout: taskDef.timeout ?? runtimeConfig.taskTimeoutMs,
        tags: taskDef.tags || [],
        copilotArgs: taskDef.copilotArgs || [],
        model: taskDef.model || null,
        id: taskDef.id || null,
        parentTaskId: taskDef.parentTaskId || null,
        originalPrompt: taskDef.originalPrompt || null,
      });
      emitter.emit('task-submitted', { taskId });
      return taskId;
    },

    /** Get a task by ID. */
    getTask(taskId) {
      return getTaskById(taskId);
    },

    /** List tasks with optional filter. */
    listTasks(filter = {}) {
      return listAllTasks(filter);
    },

    /** Get queue statistics. */
    getStats() {
      return getTaskStats();
    },

    /** Cancel a pending task. Returns true if cancelled. */
    cancelTask(taskId) {
      const task = getTaskById(taskId);
      if (!task) return false;
      if (task.status !== 'pending') return false;
      failTask(taskId, 'Cancelled by user');
      emitter.emit('task-cancelled', { taskId });
      logger.info(COMPONENT, `Task ${taskId} cancelled`, taskId);
      return true;
    },

    // EventEmitter delegation
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };

  return runtime;
}
