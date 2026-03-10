// Teams notifier — posts task completion notifications with gist links
import { spawn, execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
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
 * Find output files created/modified by a task in its workdir.
 * Looks for recently modified .md, .txt, .json, .html files.
 */
function findTaskOutputFiles(workdir, startedAt) {
  const since = startedAt ? new Date(startedAt).getTime() : Date.now() - 600_000;
  const extensions = ['.md', '.txt', '.json', '.html', '.csv'];
  const results = [];

  try {
    for (const name of readdirSync(workdir)) {
      const fullPath = resolve(workdir, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && extensions.some(ext => name.endsWith(ext)) && stat.mtimeMs >= since) {
          results.push(fullPath);
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* skip unreadable dirs */ }

  return results;
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

export async function notifyTaskCompleted({ taskId, prompt, score, result, workdir, startedAt }) {
  const scoreText = score != null ? `${score}/10` : 'passed';

  // Find and upload output files to gist
  const outputFiles = findTaskOutputFiles(workdir || config.ROOT, startedAt);
  const gistLinks = [];
  for (const file of outputFiles) {
    const url = uploadToGist(file, `Orchestrator task ${taskId}: ${basename(file)}`);
    if (url) gistLinks.push({ name: basename(file), url });
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

  runtime.on('task-completed', async ({ taskId, result, score }) => {
    const task = getTaskFn(taskId);
    await notifyTaskCompleted({
      taskId,
      prompt: task?.original_prompt || task?.prompt || taskId,
      score,
      result,
      workdir: task?.workdir,
      startedAt: task?.started_at,
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
