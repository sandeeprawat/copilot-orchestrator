#!/usr/bin/env node
// CLI interface for the orchestrator
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { initDB, addTask, listTasks, getTask, getStats } from './taskdb.js';
import { startDaemon } from './daemon.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import config from './config.js';

const cli = yargs(hideBin(process.argv))
  .scriptName('orchestrator')
  .usage('$0 <command> [options]')
  .command('start', 'Start the orchestrator daemon', (yargs) => {
    return yargs
      .option('concurrency', { alias: 'c', type: 'number', describe: 'Max concurrent agents' })
      .option('debug', { alias: 'd', type: 'boolean', describe: 'Enable debug logging' });
  }, (argv) => {
    if (argv.concurrency) config.maxConcurrency = argv.concurrency;
    startDaemon();
  })
  .command('add <prompt>', 'Add a task to the queue', (yargs) => {
    return yargs
      .positional('prompt', { describe: 'Task prompt for copilot', type: 'string' })
      .option('workdir', { alias: 'w', type: 'string', describe: 'Working directory' })
      .option('priority', { alias: 'p', type: 'number', default: 5, describe: 'Priority (1=highest)' })
      .option('max-refinements', { alias: 'r', type: 'number', describe: 'Max self-improvement iterations' })
      .option('timeout', { alias: 't', type: 'number', describe: 'Timeout in seconds' })
      .option('id', { type: 'string', describe: 'Custom task ID' });
  }, (argv) => {
    initDB();
    const id = addTask({
      prompt: argv.prompt,
      workdir: argv.workdir,
      priority: argv.priority,
      maxRefinements: argv.maxRefinements ?? config.maxRefinements,
      timeout: argv.timeout ? argv.timeout * 1000 : config.taskTimeoutMs,
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
        id: t.id,
      });
      console.log(chalk.green(`✓ Imported: ${id}`));
    }
  })
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help();

cli.parse();
