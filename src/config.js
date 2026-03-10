// Configuration with sensible defaults, overridable via orchestrator.config.json
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const defaults = {
  maxConcurrency: 3,
  pollIntervalMs: 2000,
  taskTimeoutMs: 600_000, // 10 minutes
  maxRefinements: 3,
  inboxDir: resolve(ROOT, 'tasks'),
  processedDir: resolve(ROOT, 'tasks', 'processed'),
  logsDir: resolve(ROOT, 'logs'),
  dbPath: resolve(ROOT, 'orchestrator.db'),
  copilotBin: 'copilot',
  defaultCopilotArgs: ['--allow-all', '--autopilot', '--output-format', 'json', '-s'],
  gatewayPort: 18789,
  httpPort: 3000,
  soulPath: resolve(ROOT, 'SOUL.md'),
  memoryDir: resolve(ROOT, 'memory'),
  skillsDir: resolve(ROOT, 'skills'),
  sessionsDir: resolve(ROOT, 'sessions'),
  maxSessionHistory: 20,
  memorySearchResults: 5,
  autoSaveMemory: true,
  evaluationPromptTemplate: `You are a strict quality evaluator for AI agent task output.

ORIGINAL TASK:
{{TASK_PROMPT}}

AGENT OUTPUT:
{{TASK_RESULT}}

Score the output 1-10 on: correctness, completeness, code quality (if applicable), and whether it fully addresses the task.

You MUST respond with ONLY this JSON (no other text):
{
  "score": <number 1-10>,
  "passed": <true if score >= 7, false otherwise>,
  "reasoning": "<2-3 sentences explaining the score>",
  "gaps": ["<specific gap 1>", "<specific gap 2>"],
  "improvementPrompt": "<if not passed: a complete, self-contained prompt that includes what was already done and exactly what to fix/add. If passed: null>"
}`,

  refinementPromptTemplate: `You are continuing work on a task that was partially completed by a previous agent.

ORIGINAL TASK:
{{ORIGINAL_PROMPT}}

WHAT WAS ALREADY DONE (previous agent output):
{{PREVIOUS_RESULT}}

EVALUATION FEEDBACK (score: {{SCORE}}/10):
{{REASONING}}

SPECIFIC GAPS TO ADDRESS:
{{GAPS}}

Your job: Build on the existing work. Do NOT start from scratch. Fix the gaps identified above and improve the overall quality. Make sure the final result fully satisfies the original task.`,
};

function loadConfig() {
  const configPath = resolve(ROOT, 'orchestrator.config.json');
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.warn(`Warning: Failed to parse ${configPath}: ${e.message}`);
    }
  }
  return { ...defaults, ...userConfig, ROOT };
}

export const config = loadConfig();
export default config;
