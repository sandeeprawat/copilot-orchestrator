// Teams Channel adapter — polls a Teams channel for task messages, posts results back
import { spawn, execSync } from 'child_process';
import { BaseChannel } from './base.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'TeamsChannel';

// Messages starting with these prefixes are treated as tasks
const TASK_PREFIXES = ['/task ', '/run ', '/do '];

export class TeamsChannelAdapter extends BaseChannel {
  constructor(gateway) {
    super('teams-channel', gateway);
    this.teamId = config.teamsChannelTeamId;
    this.channelId = config.teamsChannelId;
    this.pollIntervalMs = config.teamsChannelPollMs || 15_000;
    this.pollTimer = null;
    this.lastSeenMessageId = null;
    this.lastSeenTimestamp = new Date().toISOString();
    this.pendingTaskMap = new Map(); // taskId → messageId (to reply in thread)
  }

  async start() {
    if (!this.teamId || !this.channelId) {
      logger.warn(COMPONENT, 'Teams channel disabled (set teamsChannelTeamId + teamsChannelId in config)');
      return;
    }

    this.running = true;
    logger.info(COMPONENT, `Polling Teams channel every ${this.pollIntervalMs / 1000}s`);

    // Post a startup message
    await this._postToChannel(
      '<p>🤖 <b>Orchestrator online.</b> Post a message starting with <code>/task</code> to assign work.</p>' +
      '<p>Example: <code>/task Search for trending AI papers this week and summarize the top 5</code></p>'
    );

    // Start polling
    this._poll();
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

  async _poll() {
    if (!this.running) return;

    try {
      const messages = await this._fetchMessages();
      if (!messages || messages.length === 0) return;

      for (const msg of messages) {
        // Skip system messages and our own messages
        if (!msg.from?.displayName || !msg.body?.content) continue;
        if (msg.id === this.lastSeenMessageId) continue;

        // Extract text from HTML content
        const text = this._stripHtml(msg.body.content).trim();
        if (!text) continue;

        // Check if it's a task
        const taskPrompt = this._extractTaskPrompt(text);
        if (!taskPrompt) continue;

        logger.info(COMPONENT, `Task from ${msg.from.displayName}: "${taskPrompt.slice(0, 80)}..."`);

        // React with acknowledgement
        await this._replyToMessage(msg.id,
          `<p>⏳ Task received from <b>${msg.from.displayName}</b>. Working on it...</p>`
        );

        // Submit task
        try {
          const taskId = await this.submitTask({
            prompt: taskPrompt,
            id: null,
            priority: 3,
            channel: 'teams-channel',
            metadata: { messageId: msg.id, author: msg.from.displayName },
          });
          this.pendingTaskMap.set(taskId, msg.id);
          logger.info(COMPONENT, `Queued as task ${taskId}`, taskId);
        } catch (e) {
          logger.error(COMPONENT, `Failed to queue task: ${e.message}`);
          await this._replyToMessage(msg.id,
            `<p>❌ Failed to queue task: ${e.message}</p>`
          );
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

  async _fetchMessages() {
    // Use copilot to call the Teams MCP
    return new Promise((resolve) => {
      const prompt = `List the most recent messages in Teams channel. Use the teams-ListChannelMessages tool with teamId="${this.teamId}" and channelId="${this.channelId}" and top=5. Return ONLY the raw JSON result, nothing else.`;

      const args = ['-p', prompt, '--allow-all', '--autopilot', '-s', '--output-format', 'json'];
      const proc = spawn(config.copilotBin, args, {
        cwd: config.ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(null); }, 45_000);

      proc.stdout.on('data', (d) => { stdout += d.toString(); });

      proc.on('close', () => {
        clearTimeout(timer);
        // Try to parse messages from the output
        try {
          const messages = this._parseMessagesFromOutput(stdout);
          if (messages && messages.length > 0) {
            // Update lastSeen to newest message
            this.lastSeenTimestamp = messages[0].createdDateTime || this.lastSeenTimestamp;
            // Only return messages newer than what we've already processed
            const newMessages = messages.filter(m =>
              m.id !== this.lastSeenMessageId &&
              new Date(m.createdDateTime) > new Date(this.lastSeenTimestamp).getTime() - this.pollIntervalMs
            );
            if (newMessages.length > 0) {
              this.lastSeenMessageId = newMessages[0].id;
            }
            resolve(newMessages.reverse()); // oldest first
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });

      proc.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  _parseMessagesFromOutput(raw) {
    // Look for JSON array of messages in JSONL output
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.message && typeof obj.message === 'string') {
          // Try to find message array in the assistant response
          const msgMatch = obj.message.match(/\[[\s\S]*\]/);
          if (msgMatch) {
            return JSON.parse(msgMatch[0]);
          }
        }
      } catch { /* skip */ }
    }
    return null;
  }

  // Post a message to the channel
  async _postToChannel(htmlContent) {
    return new Promise((resolve) => {
      const prompt = `Post this HTML message to a Teams channel. Use teams-PostChannelMessage with teamId="${this.teamId}", channelId="${this.channelId}", contentType="html", and content exactly:\n\n${htmlContent}\n\nDo not modify.`;

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

  // Reply to a specific message in the channel (threaded)
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

  // Called when a task completes — post result back to channel thread
  async onTaskComplete(task, gistLinks = []) {
    const messageId = this.pendingTaskMap.get(task.id);
    if (!messageId) return;
    this.pendingTaskMap.delete(task.id);

    const lines = [`<p>✅ <b>Task ${task.id} completed</b></p>`];

    if (gistLinks.length > 0) {
      lines.push('<p>📎 Reports:</p><ul>');
      for (const link of gistLinks) {
        lines.push(`<li><a href="${link.url}">${link.name}</a></li>`);
      }
      lines.push('</ul>');
    } else {
      const preview = (task.result || '').slice(0, 500).replace(/\n/g, '<br>');
      lines.push(`<p>${preview}</p>`);
    }

    await this._replyToMessage(messageId, lines.join('\n'));
  }

  async onTaskFailed(task) {
    const messageId = this.pendingTaskMap.get(task.id);
    if (!messageId) return;
    this.pendingTaskMap.delete(task.id);

    await this._replyToMessage(messageId,
      `<p>❌ <b>Task ${task.id} failed:</b> ${(task.error || 'Unknown error').slice(0, 300)}</p>`
    );
  }
}

export default TeamsChannelAdapter;
