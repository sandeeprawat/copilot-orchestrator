// Discord channel adapter — real-time bot via discord.js WebSocket
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { basename } from 'path';
import { BaseChannel } from './base.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'Discord';
const TASK_PREFIXES = ['/task ', '/run ', '/do '];

export class DiscordChannel extends BaseChannel {
  constructor(gateway) {
    super('discord', gateway);
    this.client = null;
    this.pendingTasks = new Map(); // taskId → { channelId, messageId }
  }

  async start() {
    const token = config.discordBotToken;
    if (!token) {
      logger.warn(COMPONENT, 'Discord disabled (set discordBotToken in config)');
      return;
    }

    this.running = true;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('ready', () => {
      logger.info(COMPONENT, `Bot online as ${this.client.user.tag}`);
    });

    this.client.on('messageCreate', (msg) => this._handleMessage(msg));

    this.client.on('error', (err) => {
      logger.error(COMPONENT, `Client error: ${err.message}`);
    });

    await this.client.login(token);
  }

  async stop() {
    await super.stop();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info(COMPONENT, 'Bot disconnected');
    }
  }

  async _handleMessage(msg) {
    // Ignore bots (including ourselves)
    if (msg.author.bot) return;

    const text = msg.content.trim();
    if (!text) return;

    // Check for task prefix
    const taskPrompt = this._extractTask(text);
    if (!taskPrompt) return;

    logger.info(COMPONENT, `Task from ${msg.author.username}: "${taskPrompt.slice(0, 80)}..."`);

    // Acknowledge
    const reply = await msg.reply('⏳ Task received. Working on it...');

    // Submit
    try {
      const taskId = await this.submitTask({
        prompt: taskPrompt,
        priority: 3,
        channel: 'discord',
        metadata: { author: msg.author.username },
      });

      this.pendingTasks.set(taskId, {
        channelId: msg.channel.id,
        messageId: reply.id,
        originalMsg: msg,
      });

      await reply.edit(`⏳ Task **${taskId}** queued. I'll reply here when it's done.`);
      logger.info(COMPONENT, `Queued as ${taskId}`, taskId);
    } catch (e) {
      logger.error(COMPONENT, `Failed to queue: ${e.message}`);
      await reply.edit(`❌ Failed to queue task: ${e.message}`);
    }
  }

  _extractTask(text) {
    for (const prefix of TASK_PREFIXES) {
      if (text.toLowerCase().startsWith(prefix)) {
        return text.slice(prefix.length).trim();
      }
    }
    return null;
  }

  async onTaskComplete(task) {
    // Walk parent chain to find the original Discord message
    const pending = this._findPending(task);
    if (!pending) return;

    try {
      const channel = await this.client.channels.fetch(pending.channelId);
      if (!channel) return;

      // Upload the specific output file to gist
      const gistLinks = [];
      const outputFile = task._outputFile;
      const gistTitle = (task.original_prompt || task.prompt || '').slice(0, 100).replace(/"/g, "'");
      if (outputFile && existsSync(outputFile)) {
        const url = this._uploadToGist(outputFile, gistTitle);
        if (url) gistLinks.push({ name: basename(outputFile), url });
      }

      const lines = [`✅ **Task completed** (score: ${task.score ?? 'passed'})`];

      if (gistLinks.length > 0) {
        lines.push('');
        lines.push('📎 **Reports:**');
        for (const link of gistLinks) {
          lines.push(`• [${link.name}](${link.url})`);
        }
      } else {
        const preview = (task.result || '').slice(0, 1800);
        lines.push('```');
        lines.push(preview);
        lines.push('```');
      }

      await pending.originalMsg.reply(lines.join('\n'));
    } catch (e) {
      logger.error(COMPONENT, `Failed to post result for ${task.id}: ${e.message}`);
    }
  }

  async onTaskFailed(task) {
    const pending = this._findPending(task);
    if (!pending) return;

    try {
      await pending.originalMsg.reply(
        `❌ **Task failed:** ${(task.error || 'Unknown error').slice(0, 500)}`
      );
    } catch (e) {
      logger.error(COMPONENT, `Failed to post failure for ${task.id}: ${e.message}`);
    }
  }

  // Walk the parent_task_id chain to find the original Discord message
  _findPending(task) {
    // Direct match
    if (this.pendingTasks.has(task.id)) {
      const p = this.pendingTasks.get(task.id);
      this.pendingTasks.delete(task.id);
      return p;
    }
    // Walk parent chain
    let parentId = task.parent_task_id;
    while (parentId) {
      if (this.pendingTasks.has(parentId)) {
        const p = this.pendingTasks.get(parentId);
        this.pendingTasks.delete(parentId);
        return p;
      }
      // Try to get grandparent via runtime
      try {
        const parentTask = this.gateway.runtime?.getTask(parentId);
        parentId = parentTask?.parent_task_id || null;
      } catch { parentId = null; }
    }
    return null;
  }

  _uploadToGist(filePath, description) {
    try {
      const output = execSync(
        `gh gist create "${filePath}" --desc "${description}"`,
        { encoding: 'utf-8', timeout: 30_000, windowsHide: true }
      );
      const urlMatch = output.match(/(https:\/\/gist\.github\.com\/\S+)/);
      return urlMatch ? urlMatch[1] : null;
    } catch {
      return null;
    }
  }
}

export default DiscordChannel;
