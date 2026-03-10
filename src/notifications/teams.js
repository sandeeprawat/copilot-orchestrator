// Teams notifier — posts task completion notifications to a Teams chat
import { spawn } from 'child_process';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'TeamsNotify';

/**
 * Send a Teams message using the Teams MCP via copilot CLI.
 */
async function sendTeamsMessage(message) {
  const chatId = config.teamsNotifyChatId;
  if (!chatId) {
    logger.debug(COMPONENT, 'No teamsNotifyChatId configured, skipping');
    return;
  }

  return new Promise((resolve) => {
    const prompt = `Post this exact message to Teams chat ID "${chatId}". Use the teams-PostMessage tool with chatId="${chatId}" and content exactly as follows:\n\n${message}\n\nDo not modify the message. Just send it.`;

    const args = ['-p', prompt, '--allow-all', '--autopilot', '-s', '--output-format', 'json'];
    const proc = spawn(config.copilotBin, args, {
      cwd: config.ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); }, 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) logger.info(COMPONENT, 'Teams notification sent');
      else logger.warn(COMPONENT, `Teams notification exit code ${code}`);
      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.warn(COMPONENT, `Teams notification error: ${err.message}`);
      resolve();
    });
  });
}

export async function notifyTaskCompleted({ taskId, prompt, score, result }) {
  const scoreText = score != null ? `${score}/10` : 'passed';
  const preview = (result || '').slice(0, 300).replace(/\n/g, ' ');

  const message = [
    `✅ **Task Completed: ${taskId}**`,
    `📋 ${prompt.slice(0, 150)}`,
    `⭐ Score: ${scoreText}`,
    `📄 ${preview}${result && result.length > 300 ? '...' : ''}`,
  ].join('\n');

  await sendTeamsMessage(message);
}

export async function notifyTaskFailed({ taskId, prompt, error }) {
  const message = [
    `❌ **Task Failed: ${taskId}**`,
    `📋 ${prompt.slice(0, 150)}`,
    `🔥 Error: ${(error || 'Unknown').slice(0, 200)}`,
  ].join('\n');

  await sendTeamsMessage(message);
}

/**
 * Attach to runtime events for automatic notifications.
 */
export function attachNotifier(runtime, getTaskFn) {
  if (!config.teamsNotifyChatId) {
    logger.info(COMPONENT, 'Teams notifications disabled (set teamsNotifyChatId in config)');
    return;
  }

  logger.info(COMPONENT, `Teams notifications → chat ${config.teamsNotifyChatId}`);

  runtime.on('task-completed', async ({ taskId, result, score }) => {
    const task = getTaskFn(taskId);
    await notifyTaskCompleted({
      taskId,
      prompt: task?.original_prompt || task?.prompt || taskId,
      score,
      result,
    });
  });

  runtime.on('task-failed', async ({ taskId, error }) => {
    const task = getTaskFn(taskId);
    await notifyTaskFailed({
      taskId,
      prompt: task?.original_prompt || task?.prompt || taskId,
      error,
    });
  });
}
