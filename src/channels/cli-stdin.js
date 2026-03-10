// Interactive CLI stdin channel — readline-based task submission
import { createInterface } from 'readline';
import chalk from 'chalk';
import { BaseChannel } from './base.js';
import logger from '../logger.js';

const COMPONENT = 'CLIStdin';

export class CLIStdinChannel extends BaseChannel {
  constructor(gateway) {
    super('cli-stdin', gateway);
    this.rl = null;
    this.pendingTasks = new Map(); // taskId → { resolve, prompt }
  }

  async start() {
    this.running = true;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    });

    console.log(chalk.cyan.bold('\n🤖 Orchestrator Interactive CLI'));
    console.log(chalk.gray('Type a prompt to submit a task. Commands: /status, /list, /quit, /memory <query>, /skills\n'));

    this._prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        this._prompt();
        return;
      }

      if (input.startsWith('/')) {
        await this._handleCommand(input);
      } else {
        await this._submitPrompt(input);
      }
    });

    this.rl.on('close', () => {
      this.running = false;
      logger.info(COMPONENT, 'CLI stdin channel closed');
    });
  }

  async stop() {
    await super.stop();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  _prompt() {
    if (this.rl && this.running) {
      this.rl.prompt();
      process.stdout.write(chalk.green('> '));
    }
  }

  async _handleCommand(input) {
    const [cmd, ...args] = input.split(/\s+/);

    switch (cmd) {
      case '/quit':
      case '/exit':
        console.log(chalk.yellow('Goodbye!'));
        this.rl.close();
        process.exit(0);
        break;

      case '/status': {
        try {
          const stats = this.gateway.getStats?.() ?? {};
          console.log(chalk.cyan('📊 Queue Status:'));
          if (Array.isArray(stats)) {
            for (const s of stats) {
              console.log(chalk.white(`   ${s.status}: ${s.count}`));
            }
          } else {
            console.log(chalk.white(`   ${JSON.stringify(stats, null, 2)}`));
          }
        } catch (err) {
          console.log(chalk.red(`Error: ${err.message}`));
        }
        break;
      }

      case '/list': {
        try {
          const tasks = this.gateway.listTasks?.({ limit: 10 }) ?? [];
          if (tasks.length === 0) {
            console.log(chalk.gray('No tasks found'));
          } else {
            console.log(chalk.cyan(`📋 Recent Tasks (${tasks.length}):`));
            for (const t of tasks) {
              const statusIcon = t.status === 'completed' ? '✅' :
                t.status === 'failed' ? '❌' :
                  t.status === 'running' ? '🔄' : '⏳';
              console.log(chalk.white(`   ${statusIcon} [${t.id}] ${t.status} — ${(t.prompt || '').slice(0, 60)}`));
            }
          }
        } catch (err) {
          console.log(chalk.red(`Error: ${err.message}`));
        }
        break;
      }

      case '/memory': {
        const query = args.join(' ');
        if (!query) {
          console.log(chalk.yellow('Usage: /memory <query>'));
        } else {
          console.log(chalk.gray(`Memory query: "${query}" (not yet implemented)`));
        }
        break;
      }

      case '/skills':
        console.log(chalk.cyan('🛠️  Available Skills:'));
        console.log(chalk.gray('   (skill listing not yet implemented)'));
        break;

      default:
        console.log(chalk.yellow(`Unknown command: ${cmd}`));
        console.log(chalk.gray('Commands: /status, /list, /quit, /memory <query>, /skills'));
        break;
    }

    this._prompt();
  }

  async _submitPrompt(prompt) {
    try {
      console.log(chalk.gray(`⏳ Submitting task...`));
      const taskId = await this.submitTask({
        prompt,
        source: 'cli:local',
      });
      console.log(chalk.green(`✅ Task submitted: ${taskId}`));
      this.pendingTasks.set(taskId, { prompt });
    } catch (err) {
      console.log(chalk.red(`❌ Failed to submit: ${err.message}`));
    }
    this._prompt();
  }

  async onTaskComplete(task) {
    const pending = this.pendingTasks.get(task.id);
    if (pending) {
      this.pendingTasks.delete(task.id);
    }

    console.log('');
    console.log(chalk.green.bold(`✅ Task ${task.id} completed (score: ${task.score ?? 'N/A'})`));
    if (task.result) {
      // Truncate very long results for display
      const display = task.result.length > 2000
        ? task.result.slice(0, 2000) + chalk.gray('\n... (truncated)')
        : task.result;
      console.log(chalk.white(display));
    }
    console.log('');
    this._prompt();
  }

  async onTaskFailed(task) {
    const pending = this.pendingTasks.get(task.id);
    if (pending) {
      this.pendingTasks.delete(task.id);
    }

    console.log('');
    console.log(chalk.red.bold(`❌ Task ${task.id} failed`));
    if (task.error) {
      console.log(chalk.red(task.error));
    }
    console.log('');
    this._prompt();
  }
}

export default CLIStdinChannel;
