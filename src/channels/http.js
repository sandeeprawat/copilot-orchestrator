// HTTP/REST API channel — Express-based task submission and query API
import express from 'express';
import { BaseChannel } from './base.js';
import { getTask, listTasks, getStats } from '../taskdb.js';
import config from '../config.js';
import logger from '../logger.js';

const COMPONENT = 'HTTPChannel';
const HTTP_PORT = config.httpPort ?? 3000;

export class HTTPChannel extends BaseChannel {
  constructor(gateway) {
    super('http', gateway);
    this.app = null;
    this.server = null;
    this.port = config.httpPort ?? HTTP_PORT;
    this.completedResults = new Map(); // taskId → result (in-memory cache)
  }

  async start() {
    this.running = true;
    this.app = express();
    this.app.use(express.json());

    this._setupRoutes();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(COMPONENT, `HTTP API listening on http://localhost:${this.port}`);
        resolve();
      });
      this.server.on('error', (err) => {
        logger.error(COMPONENT, `HTTP server error: ${err.message}`);
        reject(err);
      });
    });
  }

  async stop() {
    await super.stop();
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info(COMPONENT, 'HTTP server stopped');
          resolve();
        });
      });
    }
  }

  _setupRoutes() {
    const app = this.app;

    // Health check
    app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        channel: this.name,
      });
    });

    // Queue statistics
    app.get('/api/status', (_req, res) => {
      try {
        const stats = getStats();
        const statsMap = {};
        for (const row of stats) {
          statsMap[row.status] = row.count;
        }
        res.json({ stats: statsMap });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Submit a task
    app.post('/api/tasks', async (req, res) => {
      try {
        const { prompt, workdir, priority, maxRefinements, timeout, tags, copilotArgs, id } = req.body;

        if (!prompt) {
          res.status(400).json({ error: 'Missing required field: prompt' });
          return;
        }

        const clientAddr = req.ip || req.connection?.remoteAddress || 'unknown';
        const taskId = await this.submitTask({
          prompt,
          workdir: workdir ?? null,
          priority: priority ?? 5,
          maxRefinements: maxRefinements ?? config.maxRefinements,
          timeout: timeout ?? config.taskTimeoutMs,
          tags: tags ?? [],
          copilotArgs: copilotArgs ?? [],
          id: id ?? null,
          source: `http:${clientAddr}`,
        });

        res.status(201).json({ taskId });
        logger.info(COMPONENT, `Task submitted via HTTP: ${taskId}`, taskId);
      } catch (err) {
        logger.error(COMPONENT, `Failed to submit task: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // List tasks
    app.get('/api/tasks', (req, res) => {
      try {
        const { status, limit } = req.query;
        const tasks = listTasks({
          status: status || undefined,
          limit: limit ? parseInt(limit, 10) : 50,
        });
        res.json({ tasks, count: tasks.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get task details
    app.get('/api/tasks/:id', (req, res) => {
      try {
        const task = getTask(req.params.id);
        if (!task) {
          res.status(404).json({ error: `Task not found: ${req.params.id}` });
          return;
        }
        // Merge in completed result if cached
        const cached = this.completedResults.get(req.params.id);
        if (cached) {
          task._channelResult = cached;
        }
        res.json(task);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Cancel task
    app.delete('/api/tasks/:id', (req, res) => {
      try {
        const task = getTask(req.params.id);
        if (!task) {
          res.status(404).json({ error: `Task not found: ${req.params.id}` });
          return;
        }
        if (task.status !== 'pending') {
          res.status(409).json({ error: `Cannot cancel task in '${task.status}' state` });
          return;
        }
        // Use gateway's cancel if available, otherwise just update DB
        if (this.gateway.cancelTask) {
          this.gateway.cancelTask(req.params.id);
        }
        res.json({ taskId: req.params.id, cancelled: true });
        logger.info(COMPONENT, `Task cancelled via HTTP: ${req.params.id}`);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  async onTaskComplete(task) {
    this.completedResults.set(task.id, {
      status: 'completed',
      result: task.result,
      score: task.score,
      evaluation: task.evaluation,
      completedAt: task.completed_at,
    });
    logger.info(COMPONENT, `Task result cached for HTTP query: ${task.id}`, task.id);
  }

  async onTaskFailed(task) {
    this.completedResults.set(task.id, {
      status: 'failed',
      error: task.error,
      completedAt: task.completed_at,
    });
    logger.warn(COMPONENT, `Task failure cached for HTTP query: ${task.id}`, task.id);
  }
}

export default HTTPChannel;
