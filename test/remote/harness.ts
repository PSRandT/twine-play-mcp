import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpService } from '../../src/http.js';
import { createEgressProxy } from '../../src/egress-proxy.js';
import { RemoteSessionManager } from '../../src/remote-session.js';
import { resolvePublic } from '../../src/network-policy.js';

export async function harness(
  limits: { idleMs?: number; lifetimeMs?: number; sweepMs?: number; clock?: () => number;
    configureManager?: (manager: RemoteSessionManager) => void } = {},
) {
  process.env.TWMCP_CHROME_PATH ??= '/usr/bin/chromium';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'twine-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${dir}/key`,
      '-out',
      `${dir}/cert`,
      '-days',
      '1',
      '-subj',
      '/CN=fixture.example.org',
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(`${dir}/cert`);
  const spki = createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const requests: string[] = [];
  const hosts: string[] = [];
  const blocked: string[] = [];
  const fixture = https.createServer({ key: readFileSync(`${dir}/key`), cert }, (req, res) => {
    requests.push(req.url!);
    hosts.push(req.headers.host ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://127.0.0.1/private' });
      res.end();
      return;
    }
    if (req.url === '/external-redirect' || req.url === '/redirect-ok') {
      res.writeHead(302, {
        location: req.url === '/redirect-ok' ? '/sugarcube.html' : 'https://other.example.org/sugarcube.html',
      });
      res.end();
      return;
    }
    if (req.url === '/controls') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<main id="story"><p id="status">Waiting</p><label>Name<input name="player"></label><button onclick="document.querySelector('#status').textContent=document.querySelector('input').value">Submit</button></main>`,
      );
      return;
    }
    if (req.url === '/malicious') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<p>Network probe</p><img src="https://127.0.0.1/private"><img src="https://fixture.example.org/redirect"><iframe src="https://192.168.1.1/private"></iframe><script>fetch('https://169.254.169.254/latest').catch(()=>{});fetch('https://private.example.org/private').catch(()=>{});new WebSocket('wss://127.0.0.1/');window.open('https://fixture.example.org/external-redirect');</script><a href="https://other.example.org/game.html">Leave origin</a>`,
      );
      return;
    }
    const match = /^\/(sugarcube|harlowe|snowman|chapbook)\.html$/.exec(req.url!);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(readFileSync(new URL(`../fixtures/compiled/${match[1]}.html`, import.meta.url)));
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const port = (fixture.address() as net.AddressInfo).port;
  const proxy = await createEgressProxy({
    resolve: async (host) => {
      if (host === 'fixture.example.org' || host === 'other.example.org') return ['93.184.216.34'];
      if (host === 'private.example.org') {
        blocked.push(host);
        throw new Error('Private DNS blocked');
      }
      return resolvePublic(host);
    },
    connect: (ip) => {
      if (ip !== '93.184.216.34') throw new Error('Unexpected address');
      return net.connect(port, '127.0.0.1');
    },
  });
  const managers: RemoteSessionManager[] = [];
  class FixtureManager extends RemoteSessionManager {
    protected override launchOptions() {
      const options = super.launchOptions();
      // Trust ONLY this test certificate. Production never sets TLS exceptions.
      return { ...options, args: [...options.args!, `--ignore-certificate-errors-spki-list=${spki}`] };
    }
  }
  const secret = randomBytes(32).toString('hex');
  const service = await createHttpService({
    secret,
    proxy: proxy.url,
    ...limits,
    managerFactory: (proxy, budget) => {
      const m = new FixtureManager(proxy, budget);
      limits.configureManager?.(m);
      managers.push(m);
      return m;
    },
  });
  await new Promise<void>((r) => service.server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(service.server.address() as net.AddressInfo).port}`;
  const url = new URL(`${root}/${secret}/mcp`);
  const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
  return {
    url,
    root,
    managers,
    requests,
    hosts,
    blocked,
    async client() {
      const client = new Client({ name: 'remote-acceptance', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(url);
      try { await client.connect(transport); }
      catch (err) { await client.close().catch(() => {}); throw err; }
      clients.push({ client, transport });
      return { client, transport };
    },
    async close() {
      for (const { client, transport } of clients) {
        await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
      }
      await service.close();
      await proxy.close();
      fixture.closeAllConnections();
      await new Promise<void>((r) => fixture.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export const textOf = (result: any): string =>
  result.content
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join('\n');
const activeGame = new WeakMap<Client, string>();
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const handle = activeGame.get(client);
  const scoped = name !== 'open_game' && handle ? { game_id: handle, ...args } : args;
  const r = await client.callTool({ name, arguments: scoped });
  if (r.isError) throw new Error(`${name}: ${textOf(r)}`);
  if (name === 'open_game') {
    const match = textOf(r).match(/game_[a-f0-9]{64}/);
    if (match) activeGame.set(client, match[0]);
  }
  if (name === 'session' && args.action === 'close' && scoped.game_id === handle) activeGame.delete(client);
  return r;
}
export async function json(client: Client, name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(textOf(await call(client, name, { ...args, format: 'json' })));
}
