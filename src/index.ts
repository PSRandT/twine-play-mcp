#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager } from './session.js';
import { buildServer } from './server.js';

if (process.env.TWMCP_MODE && process.env.TWMCP_MODE !== 'local') {
  throw new Error('The stdio entry requires local mode. For remote-chatgpt use npm run start:http.');
}

const manager = new SessionManager();
const server = buildServer(manager);
const transport = new StdioServerTransport();

const shutdown = async (signal: string) => {
  console.error(`[twine-play-mcp] ${signal} received, shutting down…`);
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  try {
    await manager.closeAll();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await server.connect(transport);
console.error('[twine-play-mcp] ready on stdio');
