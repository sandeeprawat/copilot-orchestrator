// SQLite-backed task queue with full lifecycle management
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'TaskDB';

let db;

export function initDB() {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      workdir TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      result TEXT,
      error TEXT,
      refinement_count INTEGER DEFAULT 0,
      max_refinements INTEGER DEFAULT ${config.maxRefinements},
      parent_task_id TEXT,
      original_prompt TEXT,
      timeout_ms INTEGER DEFAULT ${config.taskTimeoutMs},
      tags TEXT DEFAULT '[]',
      copilot_args TEXT DEFAULT '[]',
      model TEXT,
      score REAL,
      evaluation TEXT,
      session_file TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
  `);

  // Migrate existing databases that don't have the model column
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN model TEXT`);
  } catch {
    // Column already exists — no-op
  }

  logger.info(COMPONENT, `Database initialized at ${config.dbPath}`);
  return db;
}

export function addTask({
  prompt,
  workdir = null,
  priority = 5,
  maxRefinements = config.maxRefinements,
  timeout = config.taskTimeoutMs,
  tags = [],
  copilotArgs = [],
  model = null,
  parentTaskId = null,
  originalPrompt = null,
  id = null,
}) {
  const taskId = id || uuidv4().slice(0, 8);
  db.prepare(`
    INSERT INTO tasks (id, prompt, workdir, priority, max_refinements, timeout_ms, tags, copilot_args, model, parent_task_id, original_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, prompt, workdir, priority, maxRefinements, timeout,
    JSON.stringify(tags), JSON.stringify(copilotArgs), model,
    parentTaskId, originalPrompt || prompt
  );
  logger.info(COMPONENT, `Task added: ${taskId} — "${prompt.slice(0, 80)}..."`, taskId);
  return taskId;
}

export function getNextPendingTasks(limit = 1) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(limit);
}

export function claimTask(taskId) {
  const result = db.prepare(`
    UPDATE tasks SET status = 'running', started_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(taskId);
  return result.changes > 0;
}

export function completeTask(taskId, { result, score, evaluation, sessionFile }) {
  db.prepare(`
    UPDATE tasks
    SET status = 'completed', result = ?, score = ?, evaluation = ?,
        session_file = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(result, score, evaluation, sessionFile, taskId);
}

export function failTask(taskId, error) {
  db.prepare(`
    UPDATE tasks
    SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(error, taskId);
}

export function requeueForRefinement(taskId, newPrompt) {
  const task = getTask(taskId);
  if (!task) return null;

  // Mark current as refined
  db.prepare(`UPDATE tasks SET status = 'refined' WHERE id = ?`).run(taskId);

  // Create new task as child
  const newId = addTask({
    prompt: newPrompt,
    workdir: task.workdir,
    priority: task.priority,
    maxRefinements: task.max_refinements,
    timeout: task.timeout_ms,
    tags: JSON.parse(task.tags),
    copilotArgs: JSON.parse(task.copilot_args),
    model: task.model || null,
    parentTaskId: taskId,
    originalPrompt: task.original_prompt,
  });

  // Update refinement count on new task
  db.prepare(`UPDATE tasks SET refinement_count = ? WHERE id = ?`)
    .run(task.refinement_count + 1, newId);

  logger.info(COMPONENT, `Task ${taskId} re-queued as ${newId} (refinement #${task.refinement_count + 1})`, taskId);
  return newId;
}

export function getTask(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

export function listTasks({ status, limit = 50 } = {}) {
  if (status) {
    return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function getStats() {
  return db.prepare(`
    SELECT status, COUNT(*) as count FROM tasks GROUP BY status
  `).all();
}

export function getRunningCount() {
  return db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'running'`).get().count;
}

export function getDB() {
  return db;
}
