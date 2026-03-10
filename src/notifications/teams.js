// Teams notifier — posts task completion notifications with gist links
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { basename } from 'path';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'TeamsNotify';

/**
 * Upload a file to GitHub Gist and return the URL.
 */
function uploadToGist(filePath, description) {
  try {
    const output = execSync(
      `gh gist create "${filePath}" --desc "${description}"`,
      { cwd: config.ROOT, encoding: 'utf-8', timeout: 30_000, windowsHide: true }
    );
    const urlMatch = output.match(/(https:\/\/gist\.github\.com\/\S+)/);
    if (urlMatch) {
      logger.info(COMPONENT, `Uploaded to gist: ${urlMatch[1]}`);
      return urlMatch[1];
    }
  } catch (e) {
    logger.warn(COMPONENT, `Gist upload failed for ${filePath}: ${e.message}`);
  }
  return null;
}

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
    const prompt = `Post this exact HTML message to Teams chat ID "${chatId}". Use the teams-PostMessage tool with chatId="${chatId}", contentType="html", and content exactly as follows:\n\n${message}\n\nDo not modify the message. Send it as HTML.`;

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

export async function notifyTaskCompleted({ taskId, prompt, score, result, outputFile }) {
  const scoreText = score != null ? `${score}/10` : 'passed';
  const gistTitle = prompt.slice(0, 100).replace(/"/g, "'");

  // Upload the specific output file if it exists
  const gistLinks = [];
  if (outputFile && existsSync(outputFile)) {
    const url = uploadToGist(outputFile, gistTitle);
    if (url) gistLinks.push({ name: basename(outputFile), url });
  }

  const lines = [
    `<p><b>✅ Task Completed: ${taskId}</b></p>`,
    `<p>📋 ${prompt.slice(0, 150)}</p>`,
    `<p>⭐ Score: ${scoreText}</p>`,
  ];

  if (gistLinks.length > 0) {
    lines.push('<p>📎 <b>Reports:</b></p><ul>');
    for (const link of gistLinks) {
      lines.push(`<li><a href="${link.url}">${link.name}</a></li>`);
    }
    lines.push('</ul>');
  } else {
    const preview = (result || '').slice(0, 300).replace(/\n/g, ' ');
    lines.push(`<p>📄 ${preview}${result && result.length > 300 ? '...' : ''}</p>`);
  }

  await sendTeamsMessage(lines.join('\n'));
}

export async function notifyTaskFailed({ taskId, prompt, error }) {
  const message = [
    `<p><b>❌ Task Failed: ${taskId}</b></p>`,
    `<p>📋 ${prompt.slice(0, 150)}</p>`,
    `<p>🔥 Error: ${(error || 'Unknown').slice(0, 200)}</p>`,
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

  runtime.on('task-completed', async ({ taskId, result, score, outputFile }) => {
    const task = getTaskFn(taskId);
    await notifyTaskCompleted({
      taskId,
      prompt: task?.original_prompt || task?.prompt || taskId,
      score,
      result,
      outputFile,
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
