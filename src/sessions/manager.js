// Session management — persistent sessions with history for multi-turn context
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../taskdb.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'SessionMgr';
const MAX_CONTEXT_MESSAGES = config.maxSessionContext ?? 20;

/**
 * Initialize the sessions table in the existing SQLite database.
 */
export function initSessions() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      routing_key TEXT NOT NULL,
      workdir TEXT,
      history TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_routing_key ON sessions(routing_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);
  `);
  logger.info(COMPONENT, 'Sessions table initialized');
}

/**
 * Find existing session by routingKey or create a new one.
 * routingKey format: "channel:identifier" (e.g. "http:192.168.1.1", "cli:local", "file:tasks/foo.json")
 */
export function getOrCreateSession(routingKey, workdir = null) {
  const db = getDB();

  // Try to find existing active session
  const existing = db.prepare(
    'SELECT * FROM sessions WHERE routing_key = ? ORDER BY last_active_at DESC LIMIT 1'
  ).get(routingKey);

  if (existing) {
    // Touch last_active_at
    db.prepare('UPDATE sessions SET last_active_at = datetime(\'now\') WHERE id = ?').run(existing.id);
    logger.debug(COMPONENT, `Resuming session ${existing.id} for ${routingKey}`);
    return {
      id: existing.id,
      routingKey: existing.routing_key,
      workdir: existing.workdir,
      history: JSON.parse(existing.history || '[]'),
      createdAt: existing.created_at,
      lastActiveAt: existing.last_active_at,
    };
  }

  // Create new session
  const id = uuidv4().slice(0, 12);
  db.prepare(
    'INSERT INTO sessions (id, routing_key, workdir) VALUES (?, ?, ?)'
  ).run(id, routingKey, workdir);

  logger.info(COMPONENT, `New session created: ${id} for ${routingKey}`);
  return {
    id,
    routingKey,
    workdir,
    history: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

/**
 * Append a message to session history.
 * @param {string} sessionId
 * @param {'user'|'assistant'|'system'} role
 * @param {string} content
 */
export function addToHistory(sessionId, role, content) {
  const db = getDB();
  const row = db.prepare('SELECT history FROM sessions WHERE id = ?').get(sessionId);
  if (!row) {
    logger.warn(COMPONENT, `Session not found: ${sessionId}`);
    return;
  }

  const history = JSON.parse(row.history || '[]');
  history.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });

  db.prepare(
    'UPDATE sessions SET history = ?, last_active_at = datetime(\'now\') WHERE id = ?'
  ).run(JSON.stringify(history), sessionId);

  logger.debug(COMPONENT, `Added ${role} message to session ${sessionId} (${history.length} total)`);
}

/**
 * Get formatted session context for system prompt injection.
 * Returns the last N messages formatted for the agent.
 */
export function getSessionContext(sessionId) {
  const db = getDB();
  const row = db.prepare('SELECT history, workdir FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;

  const history = JSON.parse(row.history || '[]');
  const recent = history.slice(-MAX_CONTEXT_MESSAGES);

  if (recent.length === 0) return null;

  const lines = recent.map((msg) => {
    const prefix = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    return `[${prefix}]: ${msg.content}`;
  });

  return {
    sessionId,
    workdir: row.workdir,
    messageCount: history.length,
    context: lines.join('\n\n'),
  };
}

/**
 * List all sessions, optionally with recent activity.
 */
export function listSessions() {
  const db = getDB();
  const rows = db.prepare(
    'SELECT id, routing_key, workdir, created_at, last_active_at, LENGTH(history) as history_size FROM sessions ORDER BY last_active_at DESC'
  ).all();

  return rows.map((row) => ({
    id: row.id,
    routingKey: row.routing_key,
    workdir: row.workdir,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    historySize: row.history_size,
  }));
}

/**
 * Remove sessions older than maxAgeMs.
 */
export function cleanupSessions(maxAgeMs = 24 * 60 * 60 * 1000) {
  const db = getDB();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db.prepare(
    'DELETE FROM sessions WHERE last_active_at < ?'
  ).run(cutoff);

  if (result.changes > 0) {
    logger.info(COMPONENT, `Cleaned up ${result.changes} stale session(s)`);
  }
  return result.changes;
}

export default {
  initSessions,
  getOrCreateSession,
  addToHistory,
  getSessionContext,
  listSessions,
  cleanupSessions,
};
