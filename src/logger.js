// Structured logging with per-task log files and colored console output
import chalk from 'chalk';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import config from './config.js';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = LOG_LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
}

function timestamp() {
  return new Date().toISOString();
}

function formatMsg(level, component, msg) {
  return `[${timestamp()}] [${level.toUpperCase()}] [${component}] ${msg}`;
}

const levelColors = {
  error: chalk.red.bold,
  warn: chalk.yellow,
  info: chalk.cyan,
  debug: chalk.gray,
};

function log(level, component, msg, taskId = null) {
  if (LOG_LEVELS[level] > currentLevel) return;

  const formatted = formatMsg(level, component, msg);
  const colorFn = levelColors[level] || chalk.white;
  console.log(colorFn(formatted));

  // Also write to task-specific log if taskId provided
  if (taskId) {
    if (!existsSync(config.logsDir)) mkdirSync(config.logsDir, { recursive: true });
    const logFile = resolve(config.logsDir, `task-${taskId}.log`);
    appendFileSync(logFile, formatted + '\n');
  }
}

export const logger = {
  error: (component, msg, taskId) => log('error', component, msg, taskId),
  warn: (component, msg, taskId) => log('warn', component, msg, taskId),
  info: (component, msg, taskId) => log('info', component, msg, taskId),
  debug: (component, msg, taskId) => log('debug', component, msg, taskId),
};

export default logger;
