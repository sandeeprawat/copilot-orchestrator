// Teams Channel adapter — polls a Teams channel for task messages via Graph API
import { spawn, execSync } from 'child_process';
import https from 'https';
import { BaseChannel } from './base.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'TeamsChannel';
const TASK_PREFIXES = ['/task ', '/run ', '/do '];

function getGraphToken() {
  return execSync(
    'az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv',
    { encoding: 'utf-8', timeout: 15_000, windowsHide: true }
  ).trim();
}

function graphGet(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export class TeamsChannelAdapter extends BaseChannel {
  constructor(gateway) {
    super('teams-channel', gateway);
    this.teamId = config.teamsChannelTeamId;
    this.channelId = config.teamsChannelId;
    this.pollIntervalMs = config.teamsChannelPollMs || 15_000;
    this.pollTimer = null;
    this.seenMessageIds = new Set();
    this.pendingTaskMap = new Map(); // taskId → messageId
    this.token = null;
    this.tokenExpiry = 0;
  }

  async start() {
    if (!this.teamId || !this.channelId) {
      logger.warn(COMPONENT, 'Teams channel disabled (set teamsChannelTeamId + teamsChannelId in config)');
      return;
    }

    this.running = true;

    // Seed seenMessageIds with current messages so we don't process old ones
    try {
      await this._refreshToken();
      const data = await graphGet(
        `/teams/${this.teamId}/channels/${this.channelId}/messages?$top=10`, this.token
      );
      if (data?.value) {
        for (const msg of data.value) this.seenMessageIds.add(msg.id);
      }
    } catch (e) {
      logger.warn(COMPONENT, `Failed to seed message history: ${e.message}`);
    }

    logger.info(COMPONENT, `Polling Teams channel every ${this.pollIntervalMs / 1000}s`);
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  async stop() {
    await super.stop();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info(COMPONENT, 'Teams channel adapter stopped');
  }

  async _refreshToken() {
    if (Date.now() < this.tokenExpiry - 60_000) return;
    this.token = getGraphToken();
    this.tokenExpiry = Date.now() + 50 * 60_000; // ~50 min
  }

  async _poll() {
    if (!this.running) return;

    try {
      await this._refreshToken();
      const data = await graphGet(
        `/teams/${this.teamId}/channels/${this.channelId}/messages?$top=10`, this.token
      );

      if (!data?.value) return;

      for (const msg of data.value) {
        if (this.seenMessageIds.has(msg.id)) continue;
        this.seenMessageIds.add(msg.id);

        if (!msg.from?.user?.displayName || !msg.body?.content) continue;

        const text = this._stripHtml(msg.body.content).trim();
        const taskPrompt = this._extractTaskPrompt(text);
        if (!taskPrompt) continue;

        logger.info(COMPONENT, `Task from ${msg.from.user.displayName}: "${taskPrompt.slice(0, 80)}..."`);

        // Reply in thread
        this._replyToMessage(msg.id,
          `<p>⏳ Task received from <b>${msg.from.user.displayName}</b>. Working on it...</p>`
        ).catch(() => {});

        try {
          const taskId = await this.submitTask({
            prompt: taskPrompt,
            priority: 3,
            channel: 'teams-channel',
          });
          this.pendingTaskMap.set(taskId, msg.id);
          logger.info(COMPONENT, `Queued as task ${taskId}`, taskId);
        } catch (e) {
          logger.error(COMPONENT, `Failed to queue task: ${e.message}`);
        }
      }
    } catch (e) {
      logger.debug(COMPONENT, `Poll error: ${e.message}`);
    }
  }

  _extractTaskPrompt(text) {
    for (const prefix of TASK_PREFIXES) {
      if (text.toLowerCase().startsWith(prefix)) {
        return text.slice(prefix.length).trim();
      }
    }
    return null;
  }

  _stripHtml(html) {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _replyToMessage(messageId, htmlContent) {
    return new Promise((resolve) => {
      const prompt = `Reply to a message in a Teams channel thread. Use teams-ReplyToChannelMessage with teamId="${this.teamId}", channelId="${this.channelId}", messageId="${messageId}", contentType="html", and content exactly:\n\n${htmlContent}\n\nDo not modify.`;

      const args = ['-p', prompt, '--allow-all', '--autopilot', '-s', '--output-format', 'json'];
      const proc = spawn(config.copilotBin, args, {
        cwd: config.ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 60_000);
      proc.on('close', () => { clearTimeout(timer); resolve(); });
      proc.on('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  async onTaskComplete(task) {
    const messageId = this._findPendingMessageId(task);
    if (!messageId) return;

    const lines = [`<p>✅ <b>Task ${task.id} completed</b></p>`];
    const preview = (task.result || '').slice(0, 500).replace(/\n/g, '<br>');
    lines.push(`<p>${preview}</p>`);

    await this._replyToMessage(messageId, lines.join('\n'));
  }

  async onTaskFailed(task) {
    const messageId = this._findPendingMessageId(task);
    if (!messageId) return;

    await this._replyToMessage(messageId,
      `<p>❌ <b>Task ${task.id} failed:</b> ${(task.error || 'Unknown error').slice(0, 300)}</p>`
    );
  }

  _findPendingMessageId(task) {
    if (this.pendingTaskMap.has(task.id)) {
      const id = this.pendingTaskMap.get(task.id);
      this.pendingTaskMap.delete(task.id);
      return id;
    }
    let parentId = task.parent_task_id;
    while (parentId) {
      if (this.pendingTaskMap.has(parentId)) {
        const id = this.pendingTaskMap.get(parentId);
        this.pendingTaskMap.delete(parentId);
        return id;
      }
      try {
        const parentTask = this.gateway.runtime?.getTask(parentId);
        parentId = parentTask?.parent_task_id || null;
      } catch { parentId = null; }
    }
    return null;
  }
}

export default TeamsChannelAdapter;
