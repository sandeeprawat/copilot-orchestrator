import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import config from '../config.js';

const MEMORY_DIR = resolve(config.ROOT, 'memory');
const MAIN_FILE = resolve(MEMORY_DIR, 'MEMORY.md');

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function topicPath(topic) {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return resolve(MEMORY_DIR, `topic-${slug}.md`);
}

function timestamp() {
  return new Date().toISOString();
}

/**
 * Append a memory entry with timestamp to a topic file.
 * If topic is 'main', writes to MEMORY.md instead.
 */
export function save(topic, content, title = '') {
  ensureDir();
  const file = topic === 'main' ? MAIN_FILE : topicPath(topic);
  const heading = title || topic;
  const entry = `\n## [${timestamp()}] ${heading}\n${content}\n`;

  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8');
    writeFileSync(file, existing + entry, 'utf-8');
  } else {
    const header = topic === 'main'
      ? `# Orchestrator Memory\n`
      : `# Memory: ${topic}\n`;
    writeFileSync(file, header + entry, 'utf-8');
  }
}

/**
 * Load the full contents of a topic file.
 * Returns null if the file does not exist.
 */
export function load(topic) {
  const file = topic === 'main' ? MAIN_FILE : topicPath(topic);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * List all memory topics (derived from filenames in the memory dir).
 */
export function listTopics() {
  ensureDir();
  const files = readdirSync(MEMORY_DIR);
  const topics = [];

  for (const f of files) {
    if (f === 'MEMORY.md') {
      topics.push('main');
    } else if (f.startsWith('topic-') && f.endsWith('.md')) {
      topics.push(f.replace(/^topic-/, '').replace(/\.md$/, ''));
    }
  }

  return topics;
}

/**
 * Keyword search across all memory files.
 * Returns matching paragraphs with source citations.
 */
export function search(query) {
  ensureDir();
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
  const results = [];

  for (const file of files) {
    const filePath = resolve(MEMORY_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const source = file === 'MEMORY.md' ? 'main' : file.replace(/^topic-/, '').replace(/\.md$/, '');

    // Split into sections by ## headings
    const sections = content.split(/(?=^## )/m);

    for (const section of sections) {
      const lower = section.toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) {
        const firstLine = section.split('\n')[0].trim();
        results.push({
          source,
          heading: firstLine,
          content: section.trim(),
        });
      }
    }
  }

  return results;
}

/**
 * Returns relevant memory snippets formatted for system prompt injection.
 */
export function getContext(query) {
  if (!query) return '';

  const matches = search(query);
  if (matches.length === 0) return '';

  const lines = matches.map(m =>
    `[${m.source}] ${m.heading}\n${m.content}`
  );
  return lines.join('\n\n---\n\n');
}

export default { save, load, listTopics, search, getContext };
