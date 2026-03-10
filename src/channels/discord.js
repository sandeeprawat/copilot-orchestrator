// Discord channel adapter — real-time bot via discord.js WebSocket
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
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
    const pending = this.pendingTasks.get(task.id);
    if (!pending) return;
    this.pendingTasks.delete(task.id);

    try {
      const channel = await this.client.channels.fetch(pending.channelId);
      if (!channel) return;

      // Upload output files to gist
      const gistLinks = this._uploadOutputs(task);

      const lines = [`✅ **Task ${task.id} completed**`];

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
    const pending = this.pendingTasks.get(task.id);
    if (!pending) return;
    this.pendingTasks.delete(task.id);

    try {
      await pending.originalMsg.reply(
        `❌ **Task ${task.id} failed:** ${(task.error || 'Unknown error').slice(0, 500)}`
      );
    } catch (e) {
      logger.error(COMPONENT, `Failed to post failure for ${task.id}: ${e.message}`);
    }
  }

  _uploadOutputs(task) {
    const workdir = task.workdir || config.ROOT;
    const since = task.started_at ? new Date(task.started_at).getTime() : Date.now() - 600_000;
    const extensions = ['.md', '.txt', '.json', '.html', '.csv'];
    const links = [];

    try {
      for (const name of readdirSync(workdir)) {
        const fullPath = resolve(workdir, name);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && extensions.some(ext => name.endsWith(ext)) && stat.mtimeMs >= since) {
            const output = execSync(
              `gh gist create "${fullPath}" --desc "Task ${task.id}: ${name}"`,
              { encoding: 'utf-8', timeout: 30_000, windowsHide: true }
            );
            const urlMatch = output.match(/(https:\/\/gist\.github\.com\/\S+)/);
            if (urlMatch) links.push({ name, url: urlMatch[1] });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return links;
  }
}

export default DiscordChannel;
