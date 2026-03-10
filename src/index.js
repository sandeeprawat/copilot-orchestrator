import { createAgentRuntime } from './agents/runtime.js';
import { startGateway, broadcastEvent, submitTask as gwSubmitTask } from './gateway/server.js';
import { FileInboxChannel } from './channels/file-inbox.js';
import { HTTPChannel } from './channels/http.js';
import { CLIStdinChannel } from './channels/cli-stdin.js';
import { attachNotifier } from './notifications/teams.js';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'Main';

export async function startOrchestrator(options = {}) {
  // Create agent runtime
  const runtime = createAgentRuntime(config);
  await runtime.start();

  // Attach Teams notifier (auto-posts on task-completed / task-failed)
  attachNotifier(runtime, (taskId) => runtime.getTask(taskId));

  // Start gateway WebSocket server
  startGateway(runtime);

  // Build a gateway interface object that channels can use
  const gateway = {
    submitTask: gwSubmitTask,
    broadcastEvent,
    runtime,
  };

  // Start channels
  const channels = [];

  // File inbox always active
  const fileChannel = new FileInboxChannel(gateway);
  await fileChannel.start();
  channels.push(fileChannel);

  // HTTP channel
  const httpChannel = new HTTPChannel(gateway);
  await httpChannel.start();
  channels.push(httpChannel);

  // CLI stdin channel (interactive mode)
  if (options.interactive) {
    const cliChannel = new CLIStdinChannel(gateway);
    await cliChannel.start();
    channels.push(cliChannel);
  }

  logger.info(COMPONENT, '═══════════════════════════════════════════════');
  logger.info(COMPONENT, '  Copilot Orchestrator (OpenClaw-style)');
  logger.info(COMPONENT, `  Gateway: ws://localhost:${config.gatewayPort}`);
  logger.info(COMPONENT, `  HTTP API: http://localhost:${config.httpPort}`);
  logger.info(COMPONENT, `  Concurrency: ${config.maxConcurrency}`);
  if (config.mcpConfigPath) logger.info(COMPONENT, `  MCP config: ${config.mcpConfigPath}`);
  if (config.teamsNotifyChatId) logger.info(COMPONENT, `  Teams notify: ${config.teamsNotifyChatId}`);
  logger.info(COMPONENT, '═══════════════════════════════════════════════');

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(COMPONENT, `${signal} received, shutting down...`);
    for (const ch of channels) await ch.stop();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { runtime, gateway, channels };
}

// Auto-start if run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('index.js') ||
  process.argv[1].endsWith('src\\index.js') ||
  process.argv[1].endsWith('src/index.js')
);
if (isMain) {
  startOrchestrator({ interactive: false });
}
