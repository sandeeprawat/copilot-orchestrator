// Inbox watcher: monitors tasks/ directory for new .json task files
import chokidar from 'chokidar';
import { readFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { addTask } from './taskdb.js';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'Inbox';

let watcher = null;

export function startInboxWatcher() {
  if (!existsSync(config.inboxDir)) mkdirSync(config.inboxDir, { recursive: true });
  if (!existsSync(config.processedDir)) mkdirSync(config.processedDir, { recursive: true });

  logger.info(COMPONENT, `Watching inbox: ${config.inboxDir}`);

  watcher = chokidar.watch(resolve(config.inboxDir, '*.json'), {
    ignoreInitial: false, // process existing files on startup
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: [config.processedDir],
  });

  watcher.on('add', (filePath) => {
    processInboxFile(filePath);
  });

  watcher.on('error', (err) => {
    logger.error(COMPONENT, `Watcher error: ${err.message}`);
  });

  return watcher;
}

function processInboxFile(filePath) {
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
      addTask({
        prompt: task.prompt,
        workdir: task.workdir || null,
        priority: task.priority || 5,
        maxRefinements: task.maxRefinements ?? config.maxRefinements,
        timeout: task.timeout ?? config.taskTimeoutMs,
        tags: task.tags || [],
        copilotArgs: task.copilotArgs || [],
        id: task.id || null,
      });
    }

    // Move to processed
    const dest = resolve(config.processedDir, `${Date.now()}-${fileName}`);
    renameSync(filePath, dest);
    logger.info(COMPONENT, `Moved ${fileName} to processed/`);
  } catch (e) {
    logger.error(COMPONENT, `Failed to process ${fileName}: ${e.message}`);
    // Move to processed with error prefix
    try {
      const dest = resolve(config.processedDir, `ERROR-${Date.now()}-${fileName}`);
      renameSync(filePath, dest);
    } catch { /* ignore move errors */ }
  }
}

export function stopInboxWatcher() {
  if (watcher) {
    watcher.close();
    logger.info(COMPONENT, 'Inbox watcher stopped');
  }
}
