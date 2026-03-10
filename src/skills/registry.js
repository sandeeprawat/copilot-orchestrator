import { readdirSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import config from '../config.js';
import logger from '../logger.js';

const SKILLS_DIR = resolve(config.ROOT, 'skills');
const COMPONENT = 'SkillRegistry';

/** @type {Map<string, { manifest: object, handler: Function }>} */
const skills = new Map();

/**
 * Scan skills/ dir and register all valid skills.
 * Each skill dir must have manifest.json + handler.js.
 */
export async function loadSkills() {
  skills.clear();

  if (!existsSync(SKILLS_DIR)) {
    logger.warn(COMPONENT, `Skills directory not found: ${SKILLS_DIR}`);
    return;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = resolve(SKILLS_DIR, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    const handlerPath = join(dir, 'handler.js');

    if (!existsSync(manifestPath)) {
      logger.debug(COMPONENT, `Skipping ${entry.name}: no manifest.json`);
      continue;
    }
    if (!existsSync(handlerPath)) {
      logger.debug(COMPONENT, `Skipping ${entry.name}: no handler.js`);
      continue;
    }

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      if (!manifest.name || !manifest.description) {
        logger.warn(COMPONENT, `Invalid manifest in ${entry.name}: missing name or description`);
        continue;
      }

      const handlerUrl = pathToFileURL(handlerPath).href;
      const mod = await import(handlerUrl);
      const handler = mod.default;

      if (typeof handler !== 'function') {
        logger.warn(COMPONENT, `Invalid handler in ${entry.name}: default export is not a function`);
        continue;
      }

      skills.set(manifest.name, { manifest, handler });
      logger.info(COMPONENT, `Registered skill: ${manifest.name}`);
    } catch (err) {
      logger.error(COMPONENT, `Failed to load skill ${entry.name}: ${err.message}`);
    }
  }
}

/**
 * Return array of {name, description, params} for all registered skills.
 */
export function listSkills() {
  return [...skills.values()].map(({ manifest }) => ({
    name: manifest.name,
    description: manifest.description,
    params: manifest.params || {},
  }));
}

/**
 * Validate params and run the named skill handler.
 */
export async function executeSkill(name, params = {}) {
  const skill = skills.get(name);
  if (!skill) {
    throw new Error(`Unknown skill: "${name}"`);
  }

  const { manifest, handler } = skill;

  // Basic required-field validation
  const required = manifest.params?.required || [];
  for (const field of required) {
    if (params[field] === undefined || params[field] === null) {
      throw new Error(`Missing required parameter "${field}" for skill "${name}"`);
    }
  }

  logger.info(COMPONENT, `Executing skill: ${name}`, undefined);
  try {
    const result = await handler(params);
    logger.info(COMPONENT, `Skill ${name} completed`, undefined);
    return result;
  } catch (err) {
    logger.error(COMPONENT, `Skill ${name} failed: ${err.message}`, undefined);
    throw err;
  }
}

/**
 * Return formatted text catalog for system prompt injection.
 */
export function getSkillCatalog() {
  const list = listSkills();
  if (list.length === 0) return 'No skills registered.';

  const lines = list.map(s => {
    const paramDesc = s.params?.properties
      ? Object.entries(s.params.properties)
          .map(([k, v]) => `    - ${k} (${v.type || 'any'}): ${v.description || ''}`)
          .join('\n')
      : '    (no parameters)';

    const requiredNote = s.params?.required?.length
      ? `  Required: ${s.params.required.join(', ')}`
      : '';

    return `- **${s.name}**: ${s.description}\n  Parameters:\n${paramDesc}\n${requiredNote}`;
  });

  return lines.join('\n\n');
}

export default { loadSkills, listSkills, executeSkill, getSkillCatalog };
