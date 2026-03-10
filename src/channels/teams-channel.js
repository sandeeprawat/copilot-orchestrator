// Teams Channel adapter — polls a Teams channel for task messages via MCP
import { spawn } from 'child_process';
import { BaseChannel } from './base.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'TeamsChannel';
const TASK_PREFIXES = ['/task ', '/run ', '/do '];

// Call the Teams MCP server to list channel messages
function callTeamsMcp(teamId, channelId) {
  return new Promise((resolve) => {
    const proc = spawn('agency', ['mcp', 'teams'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 20_000);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      // Check if we got a response
      if (stdout.includes('"result"')) {
        clearTimeout(timer);
        proc.kill();
        try {
          const lines = stdout.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.result?.content) {
                const textContent = parsed.result.content.find(c => c.type === 'text');
                if (textContent) {
                  resolve(JSON.parse(textContent.text));
                  return;
                }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        resolve(null);
      }
    });

    proc.on('close', () => { clearTimeout(timer); resolve(null); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });

    // Send initialize
    const initReq = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orchestrator', version: '1.0' } } });
    proc.stdin.write(initReq + '\n');

    // Send the tool call after a short delay
    setTimeout(() => {
      const callReq = JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'teams-ListChannelMessages',
          arguments: { teamId, channelId, top: 10 }
        }
      });
      proc.stdin.write(callReq + '\n');
    }, 1000);
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
    this.pendingTaskMap = new Map();
  }

  async start() {
    if (!this.teamId || !this.channelId) {
      logger.warn(COMPONENT, 'Teams channel disabled (set teamsChannelTeamId + teamsChannelId in config)');
      return;
    }

    this.running = true;

    // Seed with current messages
    try {
      const data = await callTeamsMcp(this.teamId, this.channelId);
      if (data?.messages) {
        for (const msg of data.messages) this.seenMessageIds.add(msg.id);
        logger.info(COMPONENT, `Seeded ${this.seenMessageIds.size} existing messages`);
      }
    } catch (e) {
      logger.warn(COMPONENT, `Failed to seed: ${e.message}`);
    }

    logger.info(COMPONENT, `Polling Teams channel every ${this.pollIntervalMs / 1000}s`);
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  async stop() {
    await super.stop();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    logger.info(COMPONENT, 'Teams channel adapter stopped');
  }

  async _poll() {
    if (!this.running) return;

    try {
      const data = await callTeamsMcp(this.teamId, this.channelId);
      if (!data?.messages) return;

      for (const msg of data.messages) {
        if (this.seenMessageIds.has(msg.id)) continue;
        this.seenMessageIds.add(msg.id);

        const author = msg.from?.displayName;
        const content = msg.body?.content;
        if (!author || !content) continue;

        const text = this._stripHtml(content).trim();
        const taskPrompt = this._extractTaskPrompt(text);
        if (!taskPrompt) continue;

        logger.info(COMPONENT, `Task from ${author}: "${taskPrompt.slice(0, 80)}..."`);

        try {
          const taskId = await this.submitTask({
            prompt: taskPrompt,
            priority: 3,
            channel: 'teams-channel',
          });
          this.pendingTaskMap.set(taskId, msg.id);
          logger.info(COMPONENT, `Queued as task ${taskId}`, taskId);
        } catch (e) {
          logger.error(COMPONENT, `Failed to queue: ${e.message}`);
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
