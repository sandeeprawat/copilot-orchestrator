import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import config from '../config.js';
import { getContext } from '../memory/index.js';
import { getSkillCatalog } from '../skills/registry.js';

const SOUL_PATH = resolve(config.ROOT, 'SOUL.md');

/**
 * Read the SOUL.md identity file from project root.
 * Returns the raw markdown content, or a fallback string if missing.
 */
export function loadSoul() {
  if (!existsSync(SOUL_PATH)) {
    return 'You are the Copilot Orchestrator — an autonomous AI agent.';
  }
  return readFileSync(SOUL_PATH, 'utf-8');
}

/**
 * Wrap content in XML-style delimiters for structured prompt sections.
 */
function section(tag, content) {
  if (!content || content.trim().length === 0) return '';
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

/**
 * Compose a full system prompt from parts.
 *
 * @param {object} options
 * @param {string}  [options.soul]           — override for SOUL.md content
 * @param {string}  [options.memoryContext]   — pre-fetched memory snippets
 * @param {string}  [options.skillCatalog]    — pre-fetched skill catalog
 * @param {string}  [options.sessionContext]  — session history / workspace info
 * @param {string}  [options.channelHints]    — channel-specific instructions
 * @returns {string} The assembled system prompt
 */
export function buildSystemPrompt({
  soul,
  memoryContext,
  skillCatalog,
  sessionContext,
  channelHints,
} = {}) {
  const parts = [];

  // Identity from SOUL.md
  const soulContent = soul ?? loadSoul();
  parts.push(section('identity', soulContent));

  // Relevant memories
  const memoryContent = memoryContext ?? '';
  parts.push(section('memory', memoryContent));

  // Available skills / tools
  const catalogContent = skillCatalog ?? getSkillCatalog();
  parts.push(section('capabilities', catalogContent));

  // Session context
  parts.push(section('session_context', sessionContext ?? ''));

  // Channel-specific hints
  parts.push(section('channel', channelHints ?? ''));

  return parts.filter(Boolean).join('\n\n');
}

export default { loadSoul, buildSystemPrompt };
