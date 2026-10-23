import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AcceptanceReport } from './public-check.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.js';
import { ContextBudget, RemoteSessionManager } from './remote-session.js';
import { createEgressProxy } from './egress-proxy.js';
import { secretPathSegment } from './private-endpoint.js';

const MAX_BODY = 32 * 1024;
const MAX_MCP_SESSIONS = 16;
const MAX_INITIALIZES_PER_MINUTE = 60;
const EMPTY_SESSION_IDLE_MS = 60_000;
const EMPTY_SESSION_RECLAIM_MS = 5_000;
export async function createHttpService(options: {
  secret: string;
  fixtures?: boolean;
  report?: AcceptanceReport;
  // Code-only test dependencies; never exposed by the entrypoint or environment.
  proxy?: string;
  managerFactory?: (proxy: string, budget: ContextBudget) => RemoteSessionManager;
  idleMs?: number;
  lifetimeMs?: number;
  sweepMs?: number;
  clock?: () => number;
}): Promise<{ server: http.Server; close: () => Promise<void> }> {
  const secret = secretPathSegment(options.secret);
  const clock = options.clock ?? Date.now;
  const proxy = options.proxy ? undefined : await createEgressProxy();
  const budget = new ContextBudget(4);
  type Owner = {
    transport: StreamableHTTPServerTransport;
    mcp: ReturnType<typeof buildServer>;
    manager: RemoteSessionManager;
    created: number;
    touched: number;
    busy: boolean;
    count: number;
    window: number;
    closing: boolean;
  };
  const owners = new Map<string, Owner>();
  const allOwners = new Set<Owner>();
  let stopping = false;
  let attempts: number[] = [];
  const remove = async (owner: Owner) => {
    if (owner.closing) return;
    owner.closing = true;
    if (owner.transport.sessionId) owners.delete(owner.transport.sessionId);
    allOwners.delete(owner);
    await owner.manager.closeAll();
    await owner.mcp.close().catch(() => undefined);
  };
  const sweep = setInterval(() => {
    const now = clock();
    for (const owner of allOwners) {
      const idleLimit = owner.manager.sessions.size === 0
        ? Math.min(options.idleMs ?? EMPTY_SESSION_IDLE_MS, EMPTY_SESSION_IDLE_MS)
        : (options.idleMs ?? 30 * 60_000);
      if (
        now - owner.created > (options.lifetimeMs ?? 4 * 60 * 60_000) ||
        (!owner.busy && now - owner.touched > idleLimit)
      )
        void remove(owner);
      else if (!owner.busy) void owner.manager.expireIdle();
    }
  }, options.sweepMs ?? 60_000);
  sweep.unref();
  const reply = (res: http.ServerResponse, status: number, message: string) => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  };
  const expected = Buffer.from(`/${secret}/mcp`);
  const server = http.createServer(async (req, res) => {
    let owner: Owner | undefined;
    let locked = false;
    try {
      if (req.method === 'GET' && req.url === '/acceptance.json' && options.report) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(options.report));
        return;
      }
      const fixture = /^\/fixtures\/(sugarcube|harlowe|snowman|chapbook)\.html$/.exec(req.url ?? '');
      if (req.method === 'GET' && fixture && options.fixtures) {
        const html = readFileSync(new URL(`../test/fixtures/compiled/${fixture[1]}.html`, import.meta.url));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end(html);
        return;
      }
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'twine-play-mcp' }));
        return;
      }
      const incoming = Buffer.from(req.url ?? '');
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
        reply(res, 404, 'Not found');
        return;
      }
      if (req.headers.origin) {
        reply(res, 403, 'Browser-origin MCP requests are disabled');
        return;
      }
      if (stopping) {
        reply(res, 503, 'Shutting down');
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId !== undefined && typeof sessionId !== 'string') {
        reply(res, 400, 'Invalid MCP session');
        return;
      }
      owner = sessionId ? owners.get(sessionId) : undefined;
      if (sessionId && !owner) {
        reply(res, 404, 'MCP session expired; reconnect');
        return;
      }
      if (req.method === 'DELETE') {
        if (!owner) {
          reply(res, 400, 'Missing MCP session');
          return;
        }
        await remove(owner);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, DELETE');
        reply(res, 405, 'Use POST for MCP');
        return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        reply(res, 415, 'Expected application/json');
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          reply(res, 413, 'Request too large');
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(res, 400, 'Invalid JSON');
        return;
      }
      if (!owner) {
        if (!isInitializeRequest(body)) {
          reply(res, 400, 'Initialize an MCP session first');
          return;
        }
        const now = clock();
        attempts = attempts.filter((t) => now - t < 60_000);
        if (attempts.length >= MAX_INITIALIZES_PER_MINUTE) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((60_000 - (now - attempts[0]!)) / 1000))));
          reply(res, 429, 'MCP initialization rate limit; retry after Retry-After seconds');
          return;
        }
        attempts.push(now);
        // Discovery/scanning connections are lightweight and do not consume a
        // browser slot. Reclaim an idle empty owner under pressure, never a game
        // or a pending request. A grace period protects fresh handshakes.
        if (allOwners.size >= MAX_MCP_SESSIONS) {
          const candidate = [...allOwners]
            .filter((o) => !o.busy && o.manager.sessions.size === 0 && now - o.touched >= EMPTY_SESSION_RECLAIM_MS)
            .sort((a, b) => a.touched - b.touched)[0];
          if (candidate) await remove(candidate);
        }
        // Cleanup awaits can interleave with other initializes. Recheck before
        // reserving a slot below; no await occurs between this check and add().
        if (allOwners.size >= MAX_MCP_SESSIONS) {
          res.setHeader('Retry-After', '5');
          reply(res, 429, 'MCP connection capacity reached; retry after Retry-After seconds');
          return;
        }
        const manager = options.managerFactory
          ? options.managerFactory(options.proxy ?? proxy!.url, budget)
          : new RemoteSessionManager(options.proxy ?? proxy!.url, budget);
        const mcp = buildServer(manager, 'remote-chatgpt');
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            owners.set(id, owner!);
          },
        });
        owner = {
          transport,
          mcp,
          manager,
          created: now,
          touched: now,
          busy: false,
          count: 0,
          window: now,
          closing: false,
        };
        allOwners.add(owner);
        const current = owner;
        transport.onclose = () => {
          void remove(current);
        };
        await mcp.connect(transport);
      }
      if (owner.busy) {
        reply(res, 429, 'One request at a time per MCP session');
        return;
      }
      if (clock() - owner.window > 60_000) {
        owner.window = clock();
        owner.count = 0;
      }
      if (++owner.count > 120) {
        res.setHeader('Retry-After', '60');
        reply(res, 429, 'Request rate limit');
        return;
      }
      owner.busy = true;
      locked = true;
      owner.touched = clock();
      const current = owner;
      const timer = setTimeout(() => {
        reply(res, 504, 'Tool timeout; session closed');
        void remove(current);
      }, 45_000);
      const disconnected = () => {
        if (!res.writableFinished) void remove(current);
      };
      res.on('close', disconnected);
      try {
        await owner.transport.handleRequest(req, res, body);
      } finally {
        clearTimeout(timer);
        res.off('close', disconnected);
        if (!owner.transport.sessionId) await remove(owner);
      }
    } catch {
      reply(res, 400, 'MCP request failed');
      if (owner && !owner.transport.sessionId) await remove(owner);
    } finally {
      if (owner && locked) {
        for (const game of owner.manager.sessions.values()) game.journal = game.journal.slice(-200);
        owner.busy = false;
        owner.touched = clock();
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_err, socket) => socket.destroy());
  return {
    server,
    async close() {
      stopping = true;
      clearInterval(sweep);
      await Promise.all([...allOwners].map(remove));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await proxy?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.TWMCP_MODE !== 'remote-chatgpt') throw new Error('HTTP entry requires TWMCP_MODE=remote-chatgpt');
  // Production startup must not launch test browsers alongside a player's game.
  // Ignore the legacy TWMCP_PUBLIC_CHECK flag, including on existing Render services.
  const report: AcceptanceReport = {
    status: 'NOT_RUN', checks: [], timestamp: new Date().toISOString(),
    note: 'Startup browser tests are disabled. Run npm run check:public explicitly, or verify through the connected MCP client.',
  };
  const secret = secretPathSegment(process.env.TWMCP_SECRET ?? '');
  const service = await createHttpService({ secret, fixtures: process.env.TWMCP_SERVE_FIXTURES === '1', report });
  service.server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0', () => {
    console.error('[twine-play-mcp] remote HTTP ready (private endpoint; URL omitted)');
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      void service.close().then(() => process.exit(0));
    });
}
