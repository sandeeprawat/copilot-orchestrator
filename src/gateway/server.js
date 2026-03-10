// WebSocket gateway server — the orchestrator control plane
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import config from '../config.js';

const COMPONENT = 'Gateway';
const GATEWAY_PORT = config.gatewayPort ?? 18789;
const SERVER_ID = uuidv4().slice(0, 12);
const CAPABILITIES = ['submit', 'status', 'health', 'get-task', 'list-tasks', 'cancel-task'];

let wss = null;
let agentRuntime = null;
let eventSeq = 0;
const clients = new Map(); // clientId → { ws, connectedAt, metadata }
const startTime = Date.now();

// ─── Built-in method handlers ───────────────────────────────────────────────

const methods = {
  health() {
    const taskStats = agentRuntime?.getStats?.() ?? {};
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      taskStats,
    };
  },

  status() {
    const connectedClients = [];
    for (const [id, info] of clients) {
      connectedClients.push({ clientId: id, connectedAt: info.connectedAt });
    }
    const taskStats = agentRuntime?.getStats?.() ?? {};
    return {
      serverId: SERVER_ID,
      connectedClients,
      taskStats,
    };
  },

  async submit(params) {
    if (!params?.prompt) {
      throw new Error('Missing required field: prompt');
    }
    if (!agentRuntime?.submitTask) {
      throw new Error('Agent runtime not available');
    }
    const taskId = await agentRuntime.submitTask({
      prompt: params.prompt,
      workdir: params.workdir ?? null,
      priority: params.priority ?? 5,
      maxRefinements: params.maxRefinements ?? config.maxRefinements,
      timeout: params.timeout ?? config.taskTimeoutMs,
      tags: params.tags ?? [],
      copilotArgs: params.copilotArgs ?? [],
      id: params.id ?? null,
    });
    return { taskId };
  },

  'get-task'(params) {
    if (!params?.taskId) throw new Error('Missing required field: taskId');
    if (!agentRuntime?.getTask) throw new Error('Agent runtime not available');
    const task = agentRuntime.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    return task;
  },

  'list-tasks'(params) {
    if (!agentRuntime?.listTasks) throw new Error('Agent runtime not available');
    return agentRuntime.listTasks({
      status: params?.status ?? undefined,
      limit: params?.limit ?? 50,
    });
  },

  'cancel-task'(params) {
    if (!params?.taskId) throw new Error('Missing required field: taskId');
    if (!agentRuntime?.cancelTask) throw new Error('Agent runtime not available');
    const cancelled = agentRuntime.cancelTask(params.taskId);
    return { taskId: params.taskId, cancelled };
  },
};

// ─── Message handling ───────────────────────────────────────────────────────

function sendJSON(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handleMessage(ws, clientId, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendJSON(ws, { type: 'error', error: 'Invalid JSON' });
    return;
  }

  if (msg.type === 'req') {
    const { id, method, params } = msg;
    if (!id || !method) {
      sendJSON(ws, { type: 'res', id: id ?? null, ok: false, error: 'Missing id or method' });
      return;
    }

    const handler = methods[method];
    if (!handler) {
      sendJSON(ws, { type: 'res', id, ok: false, error: `Unknown method: ${method}` });
      return;
    }

    try {
      const payload = await handler(params ?? {});
      sendJSON(ws, { type: 'res', id, ok: true, payload });
    } catch (err) {
      logger.warn(COMPONENT, `Method ${method} failed: ${err.message}`);
      sendJSON(ws, { type: 'res', id, ok: false, error: err.message });
    }
    return;
  }

  sendJSON(ws, { type: 'error', error: `Unexpected message type: ${msg.type}` });
}

// ─── Client connection ──────────────────────────────────────────────────────

function handleConnection(ws) {
  let clientId = null;
  let handshakeDone = false;

  // First message must be connect handshake
  const handshakeTimer = setTimeout(() => {
    if (!handshakeDone) {
      sendJSON(ws, { type: 'error', error: 'Handshake timeout' });
      ws.close(4001, 'Handshake timeout');
    }
  }, 10_000);

  ws.on('message', async (data) => {
    const raw = data.toString();

    if (!handshakeDone) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        sendJSON(ws, { type: 'error', error: 'Invalid JSON in handshake' });
        ws.close(4002, 'Invalid handshake');
        return;
      }

      if (msg.type !== 'connect' || !msg.clientId) {
        sendJSON(ws, { type: 'error', error: 'First message must be { type: "connect", clientId: "..." }' });
        ws.close(4003, 'Invalid handshake');
        return;
      }

      clientId = msg.clientId;
      handshakeDone = true;
      clearTimeout(handshakeTimer);

      clients.set(clientId, {
        ws,
        connectedAt: new Date().toISOString(),
        metadata: msg.metadata ?? {},
      });

      sendJSON(ws, {
        type: 'hello-ok',
        serverId: SERVER_ID,
        capabilities: CAPABILITIES,
      });

      logger.info(COMPONENT, `Client connected: ${clientId} (${clients.size} total)`);
      return;
    }

    await handleMessage(ws, clientId, raw);
  });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    if (clientId) {
      clients.delete(clientId);
      logger.info(COMPONENT, `Client disconnected: ${clientId} (${clients.size} remaining)`);
    }
  });

  ws.on('error', (err) => {
    logger.error(COMPONENT, `WebSocket error for ${clientId ?? 'unknown'}: ${err.message}`);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Broadcast an event to all connected clients.
 */
export function broadcastEvent(event, payload) {
  const seq = ++eventSeq;
  const msg = { type: 'event', event, payload, seq };
  const json = JSON.stringify(msg);

  for (const [, client] of clients) {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(json);
    }
  }

  logger.debug(COMPONENT, `Broadcast event: ${event} (seq=${seq}, clients=${clients.size})`);
}

/**
 * Submit a task through the gateway (used by channels).
 */
export async function submitTask(taskDef) {
  if (!agentRuntime?.submitTask) {
    throw new Error('Agent runtime not available');
  }
  return agentRuntime.submitTask(taskDef);
}

/**
 * Start the WebSocket gateway server.
 * @param {object} runtime — agent runtime with submitTask(), getTask(), listTasks(), cancelTask(), getStats()
 */
export function startGateway(runtime) {
  agentRuntime = runtime;

  const port = config.gatewayPort ?? GATEWAY_PORT;
  wss = new WebSocketServer({ port });

  wss.on('connection', handleConnection);

  wss.on('error', (err) => {
    logger.error(COMPONENT, `Gateway server error: ${err.message}`);
  });

  logger.info(COMPONENT, `WebSocket gateway listening on ws://localhost:${port}`);
  return wss;
}

/**
 * Stop the gateway server.
 */
export function stopGateway() {
  if (wss) {
    // Close all client connections
    for (const [, client] of clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    clients.clear();
    wss.close();
    wss = null;
    logger.info(COMPONENT, 'Gateway stopped');
  }
}

export default { startGateway, stopGateway, broadcastEvent, submitTask };
