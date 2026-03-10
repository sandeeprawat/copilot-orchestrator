// Executor: spawns copilot CLI processes and captures structured output
import { spawn } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'Executor';

export async function executeTask(task) {
  const taskId = task.id;
  const workdir = task.workdir || config.ROOT;
  const timeout = task.timeout_ms || config.taskTimeoutMs;
  const extraArgs = JSON.parse(task.copilot_args || '[]');

  const args = [
    '-p', task.prompt,
    ...config.defaultCopilotArgs,
    ...extraArgs,
  ];

  // Pass through MCP config so agents get tools like Teams, email, etc.
  if (config.mcpConfigPath) {
    args.push('--additional-mcp-config', `@${config.mcpConfigPath}`);
  }

  // Add --share to save session transcript
  if (!existsSync(config.logsDir)) mkdirSync(config.logsDir, { recursive: true });
  const sessionFile = resolve(config.logsDir, `session-${taskId}.md`);
  args.push('--share', sessionFile);

  logger.info(COMPONENT, `Executing task ${taskId}: "${task.prompt.slice(0, 60)}..."`, taskId);
  logger.debug(COMPONENT, `Command: ${config.copilotBin} ${args.join(' ')}`, taskId);
  logger.debug(COMPONENT, `Working directory: ${workdir}`, taskId);

  return new Promise((resolvePromise) => {
    const stdout = [];
    const stderr = [];
    let killed = false;

    const proc = spawn(config.copilotBin, args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { ...process.env, COPILOT_ALLOW_ALL: '1' },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      logger.warn(COMPONENT, `Task ${taskId} timed out after ${timeout}ms`, taskId);
    }, timeout);

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout.push(text);
      // Log individual JSONL lines for debugging
      for (const line of text.split('\n').filter(Boolean)) {
        logger.debug(COMPONENT, `[stdout] ${line.slice(0, 200)}`, taskId);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr.push(data.toString());
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const rawOutput = stdout.join('');
      const rawError = stderr.join('');

      // Parse JSONL output to extract the agent's final response
      const result = parseOutput(rawOutput, taskId);

      if (killed) {
        resolvePromise({
          success: false,
          error: `Timed out after ${timeout}ms`,
          rawOutput,
          rawError,
          result: null,
          sessionFile,
        });
      } else if (code !== 0) {
        resolvePromise({
          success: false,
          error: `Exit code ${code}: ${rawError.slice(0, 500)}`,
          rawOutput,
          rawError,
          result,
          sessionFile,
        });
      } else {
        resolvePromise({
          success: true,
          error: null,
          rawOutput,
          rawError,
          result,
          sessionFile,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        success: false,
        error: `Spawn error: ${err.message}`,
        rawOutput: stdout.join(''),
        rawError: stderr.join(''),
        result: null,
        sessionFile,
      });
    });
  });
}

function parseOutput(rawOutput, taskId) {
  // Copilot JSON output is JSONL — one JSON object per line
  const lines = rawOutput.split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      messages.push(obj);
    } catch {
      // Non-JSON line, skip
    }
  }

  // Extract assistant messages (the actual work output)
  const assistantMessages = messages
    .filter(m => m.role === 'assistant' && m.message)
    .map(m => m.message);

  if (assistantMessages.length > 0) {
    return assistantMessages.join('\n\n---\n\n');
  }

  // Fallback: return full raw output if no structured messages found
  if (rawOutput.trim()) {
    logger.debug(COMPONENT, `No structured messages found, returning raw output`, taskId);
    return rawOutput;
  }

  return null;
}
