import http from 'node:http';
import { readFileSync } from 'node:fs';
import { runPublicAcceptance, type AcceptanceReport } from './public-check.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.js';
import { ContextBudget, RemoteSessionManager } from './remote-session.js';
import { createEgressProxy } from './egress-proxy.js';
import { secretPathSegment } from './private-endpoint.js';

const MAX_BODY = 32 * 1024;
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
      if (
        now - owner.created > (options.lifetimeMs ?? 4 * 60 * 60_000) ||
        (!owner.busy && now - owner.touched > (options.idleMs ?? 30 * 60_000))
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
        if (attempts.length >= 10 || allOwners.size >= 2) {
          reply(res, 429, 'Session limit; close a session or retry later');
          return;
        }
        attempts.push(now);
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
  const report: AcceptanceReport | undefined =
    process.env.TWMCP_PUBLIC_CHECK === '1' ? { status: 'PENDING', checks: [] } : undefined;
  const secret = secretPathSegment(process.env.TWMCP_SECRET ?? '');
  const service = await createHttpService({ secret, fixtures: process.env.TWMCP_SERVE_FIXTURES === '1', report });
  service.server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0', () => {
    console.error('[twine-play-mcp] remote HTTP ready (private endpoint; URL omitted)');
    if (report) {
      const origin = process.env.RENDER_EXTERNAL_URL ?? process.env.TWMCP_PUBLIC_ORIGIN;
      if (!origin) {
        report.status = 'FAIL';
        report.failedStage = 'missing public origin';
      } else
        setTimeout(() => {
          void runPublicAcceptance(origin, secret, report);
        }, 15_000).unref();
    }
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      void service.close().then(() => process.exit(0));
    });
}
