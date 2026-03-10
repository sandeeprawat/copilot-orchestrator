// File inbox channel — watches tasks/ directory for .json task files
import chokidar from 'chokidar';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { BaseChannel } from './base.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'FileInbox';

export class FileInboxChannel extends BaseChannel {
  constructor(gateway) {
    super('file-inbox', gateway);
    this.watcher = null;
    this.inboxDir = config.inboxDir;
    this.processedDir = config.processedDir;
    this.resultsDir = resolve(config.inboxDir, '..', 'tasks', 'results');
  }

  async start() {
    if (!existsSync(this.inboxDir)) mkdirSync(this.inboxDir, { recursive: true });
    if (!existsSync(this.processedDir)) mkdirSync(this.processedDir, { recursive: true });
    if (!existsSync(this.resultsDir)) mkdirSync(this.resultsDir, { recursive: true });

    this.running = true;
    logger.info(COMPONENT, `Watching inbox: ${this.inboxDir}`);

    this.watcher = chokidar.watch(resolve(this.inboxDir, '*.json'), {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: [this.processedDir, this.resultsDir],
    });

    this.watcher.on('add', (filePath) => {
      if (this.running) this._processFile(filePath);
    });

    this.watcher.on('error', (err) => {
      logger.error(COMPONENT, `Watcher error: ${err.message}`);
    });
  }

  async stop() {
    await super.stop();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info(COMPONENT, 'File inbox watcher stopped');
    }
  }

  async _processFile(filePath) {
    const fileName = basename(filePath);
    logger.info(COMPONENT, `Processing inbox file: ${fileName}`);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const taskDef = JSON.parse(content);

      // Support both single tasks and arrays
      const tasks = Array.isArray(taskDef) ? taskDef : [taskDef];

      for (const task of tasks) {
        if (!task.prompt) {
          logger.warn(COMPONENT, `Skipping task in ${fileName}: missing 'prompt' field`);
          continue;
        }

        await this.submitTask({
          prompt: task.prompt,
          workdir: task.workdir ?? null,
          priority: task.priority ?? 5,
          maxRefinements: task.maxRefinements ?? config.maxRefinements,
          timeout: task.timeout ?? config.taskTimeoutMs,
          tags: task.tags ?? [],
          copilotArgs: task.copilotArgs ?? [],
          id: task.id ?? null,
          source: `file:${filePath}`,
        });
      }

      // Move to processed
      const dest = resolve(this.processedDir, `${Date.now()}-${fileName}`);
      renameSync(filePath, dest);
      logger.info(COMPONENT, `Moved ${fileName} to processed/`);
    } catch (e) {
      logger.error(COMPONENT, `Failed to process ${fileName}: ${e.message}`);
      try {
        const dest = resolve(this.processedDir, `ERROR-${Date.now()}-${fileName}`);
        renameSync(filePath, dest);
      } catch { /* ignore move errors */ }
    }
  }

  async onTaskComplete(task) {
    try {
      if (!existsSync(this.resultsDir)) mkdirSync(this.resultsDir, { recursive: true });
      const resultPath = resolve(this.resultsDir, `${task.id}.json`);
      writeFileSync(resultPath, JSON.stringify({
        taskId: task.id,
        status: task.status,
        prompt: task.prompt,
        result: task.result,
        score: task.score,
        evaluation: task.evaluation,
        completedAt: task.completed_at,
      }, null, 2));
      logger.info(COMPONENT, `Result written: ${resultPath}`, task.id);
    } catch (err) {
      logger.error(COMPONENT, `Failed to write result for task ${task.id}: ${err.message}`, task.id);
    }
  }

  async onTaskFailed(task) {
    try {
      if (!existsSync(this.resultsDir)) mkdirSync(this.resultsDir, { recursive: true });
      const resultPath = resolve(this.resultsDir, `${task.id}.json`);
      writeFileSync(resultPath, JSON.stringify({
        taskId: task.id,
        status: 'failed',
        prompt: task.prompt,
        error: task.error,
        completedAt: task.completed_at,
      }, null, 2));
      logger.warn(COMPONENT, `Failure result written: ${resultPath}`, task.id);
    } catch (err) {
      logger.error(COMPONENT, `Failed to write failure result for task ${task.id}: ${err.message}`, task.id);
    }
  }
}

export default FileInboxChannel;
