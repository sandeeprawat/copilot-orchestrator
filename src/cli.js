#!/usr/bin/env node
// CLI interface for the orchestrator
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { initDB, addTask, listTasks, getTask, getStats } from './taskdb.js';
import { startOrchestrator } from './index.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import config from './config.js';
import { setLogLevel } from './logger.js';

const cli = yargs(hideBin(process.argv))
  .scriptName('orchestrator')
  .usage('$0 <command> [options]')
  .command('start', 'Start the orchestrator', (yargs) => {
    return yargs
      .option('concurrency', { alias: 'c', type: 'number', describe: 'Max concurrent agents' })
      .option('debug', { alias: 'd', type: 'boolean', describe: 'Enable debug logging' })
      .option('interactive', { alias: 'i', type: 'boolean', describe: 'Enable CLI stdin channel' })
      .option('port', { type: 'number', describe: 'HTTP API port' })
      .option('ws-port', { type: 'number', describe: 'WebSocket gateway port' });
  }, (argv) => {
    if (argv.concurrency) config.maxConcurrency = argv.concurrency;
    if (argv.port) config.httpPort = argv.port;
    if (argv.wsPort) config.gatewayPort = argv.wsPort;
    if (argv.debug) setLogLevel('debug');
    startOrchestrator({ interactive: argv.interactive || false });
  })
  .command('add <prompt>', 'Add a task to the queue', (yargs) => {
    return yargs
      .positional('prompt', { describe: 'Task prompt for copilot', type: 'string' })
      .option('workdir', { alias: 'w', type: 'string', describe: 'Working directory' })
      .option('priority', { alias: 'p', type: 'number', default: 5, describe: 'Priority (1=highest)' })
      .option('max-refinements', { alias: 'r', type: 'number', describe: 'Max self-improvement iterations' })
      .option('timeout', { alias: 't', type: 'number', describe: 'Timeout in seconds' })
      .option('model', { alias: 'm', type: 'string', describe: 'Model to use (e.g. gpt-5.5, claude-opus-4.7, claude-opus-4.6)' })
      .option('id', { type: 'string', describe: 'Custom task ID' });
  }, (argv) => {
    initDB();
    const id = addTask({
      prompt: argv.prompt,
      workdir: argv.workdir,
      priority: argv.priority,
      maxRefinements: argv.maxRefinements ?? config.maxRefinements,
      timeout: argv.timeout ? argv.timeout * 1000 : config.taskTimeoutMs,
      model: argv.model || null,
      id: argv.id,
    });
    console.log(chalk.green(`✓ Task added: ${id}`));
  })
  .command('list', 'List tasks', (yargs) => {
    return yargs
      .option('status', { alias: 's', type: 'string', describe: 'Filter by status' })
      .option('limit', { alias: 'n', type: 'number', default: 20 });
  }, (argv) => {
    initDB();
    const tasks = listTasks({ status: argv.status, limit: argv.limit });

    if (tasks.length === 0) {
      console.log(chalk.yellow('No tasks found.'));
      return;
    }

    const statusColors = {
      pending: chalk.yellow,
      running: chalk.blue,
      completed: chalk.green,
      failed: chalk.red,
      refined: chalk.magenta,
    };

    console.log(chalk.bold(`\n  ${'ID'.padEnd(10)} ${'Status'.padEnd(12)} ${'Score'.padEnd(7)} ${'Ref#'.padEnd(5)} Prompt`));
    console.log(chalk.gray('  ' + '─'.repeat(80)));

    for (const t of tasks) {
      const colorFn = statusColors[t.status] || chalk.white;
      const score = t.score != null ? t.score.toFixed(1) : '—';
      const prompt = t.prompt.length > 45 ? t.prompt.slice(0, 42) + '...' : t.prompt;
      console.log(`  ${chalk.bold(t.id.padEnd(10))} ${colorFn(t.status.padEnd(12))} ${score.padEnd(7)} ${String(t.refinement_count).padEnd(5)} ${prompt}`);
    }
    console.log();
  })
  .command('status', 'Show queue statistics', {}, () => {
    initDB();
    const stats = getStats();
    console.log(chalk.bold('\n  Queue Statistics:'));
    console.log(chalk.gray('  ' + '─'.repeat(30)));
    for (const s of stats) {
      const colorFn = {
        pending: chalk.yellow,
        running: chalk.blue,
        completed: chalk.green,
        failed: chalk.red,
        refined: chalk.magenta,
      }[s.status] || chalk.white;
      console.log(`  ${colorFn(s.status.padEnd(12))} ${s.count}`);
    }
    console.log();
  })
  .command('show <id>', 'Show task details', (yargs) => {
    return yargs.positional('id', { describe: 'Task ID', type: 'string' });
  }, (argv) => {
    initDB();
    const task = getTask(argv.id);
    if (!task) {
      console.log(chalk.red(`Task not found: ${argv.id}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\n  Task: ${task.id}`));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  Status:       ${task.status}`);
    console.log(`  Prompt:       ${task.prompt}`);
    console.log(`  Working Dir:  ${task.workdir || '(default)'}`);
    console.log(`  Model:        ${task.model || '(default)'}`);
    console.log(`  Priority:     ${task.priority}`);
    console.log(`  Score:        ${task.score ?? '—'}`);
    console.log(`  Refinements:  ${task.refinement_count}/${task.max_refinements}`);
    console.log(`  Created:      ${task.created_at}`);
    console.log(`  Started:      ${task.started_at || '—'}`);
    console.log(`  Completed:    ${task.completed_at || '—'}`);

    if (task.error) {
      console.log(chalk.red(`\n  Error: ${task.error}`));
    }
    if (task.result) {
      console.log(chalk.bold('\n  Result:'));
      console.log(chalk.gray('  ' + '─'.repeat(50)));
      console.log(`  ${task.result.slice(0, 2000)}`);
    }
    if (task.session_file && existsSync(task.session_file)) {
      console.log(`\n  Session file: ${task.session_file}`);
    }
    console.log();
  })
  .command('import <file>', 'Import tasks from a JSON file', (yargs) => {
    return yargs.positional('file', { describe: 'Path to JSON file', type: 'string' });
  }, (argv) => {
    initDB();
    const filePath = resolve(argv.file);
    if (!existsSync(filePath)) {
      console.log(chalk.red(`File not found: ${filePath}`));
      process.exit(1);
    }
    const content = readFileSync(filePath, 'utf-8');
    const tasks = JSON.parse(content);
    const taskList = Array.isArray(tasks) ? tasks : [tasks];

    for (const t of taskList) {
      const id = addTask({
        prompt: t.prompt,
        workdir: t.workdir,
        priority: t.priority || 5,
        maxRefinements: t.maxRefinements ?? config.maxRefinements,
        timeout: t.timeout ?? config.taskTimeoutMs,
        tags: t.tags || [],
        copilotArgs: t.copilotArgs || [],
        model: t.model || null,
        id: t.id,
      });
      console.log(chalk.green(`✓ Imported: ${id}`));
    }
  })
  .command('compare <prompt>', 'Run a prompt across multiple models and compare results', (yargs) => {
    return yargs
      .positional('prompt', { describe: 'Task prompt to run on each model', type: 'string' })
      .option('models', {
        type: 'string',
        default: 'gpt-5.5,claude-opus-4.7,claude-opus-4.6',
        describe: 'Comma-separated list of models to compare',
      })
      .option('workdir', { alias: 'w', type: 'string', describe: 'Working directory' })
      .option('priority', { alias: 'p', type: 'number', default: 5, describe: 'Priority (1=highest)' })
      .option('max-refinements', { alias: 'r', type: 'number', default: 0, describe: 'Max self-improvement iterations' })
      .option('timeout', { alias: 't', type: 'number', describe: 'Timeout in seconds' });
  }, (argv) => {
    initDB();
    const models = argv.models.split(',').map(m => m.trim()).filter(Boolean);
    if (models.length < 2) {
      console.log(chalk.red('Please specify at least two models to compare.'));
      process.exit(1);
    }

    console.log(chalk.bold(`\n  Comparing ${models.length} models for prompt:`));
    console.log(chalk.gray(`  "${argv.prompt.slice(0, 80)}${argv.prompt.length > 80 ? '...' : ''}"\n`));

    const ids = [];
    for (const model of models) {
      const id = addTask({
        prompt: argv.prompt,
        workdir: argv.workdir,
        priority: argv.priority,
        maxRefinements: argv.maxRefinements ?? 0,
        timeout: argv.timeout ? argv.timeout * 1000 : config.taskTimeoutMs,
        model,
        tags: ['compare'],
      });
      ids.push({ model, id });
      console.log(chalk.green(`  ✓ ${chalk.bold(model.padEnd(22))} → task ${id}`));
    }

    console.log(chalk.gray(`\n  Run the orchestrator with: node src/cli.js start`));
    console.log(chalk.gray(`  Check results with:        node src/cli.js show <id>\n`));
  })
  .command('memory', 'Memory operations', (yargs) => {
    return yargs
      .command('search <query>', 'Search memory for relevant context', (yargs) => {
        return yargs
          .positional('query', { describe: 'Search query', type: 'string' })
          .option('limit', { alias: 'n', type: 'number', default: 5, describe: 'Max results' });
      }, async (argv) => {
        try {
          const { search } = await import('./memory/index.js');
          const results = search(argv.query);
          if (!results || results.length === 0) {
            console.log(chalk.yellow('No memory entries found.'));
            return;
          }
          console.log(chalk.bold(`\n  Memory results for "${argv.query}":\n`));
          for (const entry of results) {
            console.log(chalk.cyan(`  [${entry.source}]`) + ` ${entry.heading}`);
            console.log(chalk.gray(`  ${entry.content.slice(0, 200)}`));
          }
          console.log();
        } catch (e) {
          console.log(chalk.red(`Memory search failed: ${e.message}`));
        }
      })
      .command('save <topic> <content>', 'Save a fact to memory', (yargs) => {
        return yargs
          .positional('topic', { describe: 'Topic/category', type: 'string' })
          .positional('content', { describe: 'Content to remember', type: 'string' });
      }, async (argv) => {
        try {
          const { save } = await import('./memory/index.js');
          save(argv.topic, argv.content);
          console.log(chalk.green('✓ Saved to memory.'));
        } catch (e) {
          console.log(chalk.red(`Memory save failed: ${e.message}`));
        }
      })
      .command('list', 'List all memory topics', {}, async () => {
        try {
          const { listTopics } = await import('./memory/index.js');
          const topics = listTopics();
          if (!topics || topics.length === 0) {
            console.log(chalk.yellow('No memory topics.'));
            return;
          }
          console.log(chalk.bold('\n  Memory topics:\n'));
          for (const topic of topics) {
            console.log(chalk.cyan(`  • ${topic}`));
          }
          console.log();
        } catch (e) {
          console.log(chalk.red(`Memory list failed: ${e.message}`));
        }
      })
      .demandCommand(1, 'Specify a memory subcommand: search, save, list');
  })
  .command('skills', 'List available skills', {}, async () => {
    try {
      const { loadSkills, getSkillCatalog } = await import('./skills/registry.js');
      await loadSkills();
      const catalog = getSkillCatalog();
      if (!catalog) {
        console.log(chalk.yellow('No skills found.'));
        return;
      }
      console.log(chalk.bold('\n  Available Skills:\n'));
      console.log(catalog);
      console.log();
    } catch (e) {
      console.log(chalk.red(`Skills listing failed: ${e.message}`));
    }
  })
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help();

cli.parse();
