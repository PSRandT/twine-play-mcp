import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secretPathSegment } from '../../src/private-endpoint.js';

test('Render padded Base64 becomes an equivalent 256-bit URL-safe credential', () => {
  // Deliberately exercise +, / and =, rather than hoping random data includes all three.
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 251 : 255)));
  const base64 = bytes.toString('base64');
  for (const special of ['+', '/', '=']) assert.ok(base64.includes(special));
  const segment = secretPathSegment(base64);
  assert.match(segment, /^[a-zA-Z0-9_-]{43}$/);
  assert.deepEqual(Buffer.from(segment, 'base64url'), bytes);
  assert.equal(secretPathSegment(segment), segment);
  for (let i = 0; i < 100; i++) {
    const random = randomBytes(32);
    assert.equal(secretPathSegment(random.toString('base64')), random.toString('base64url'));
  }
});

test('existing URL-safe credentials and endpoints are unchanged', () => {
  for (const value of [randomBytes(32).toString('hex'), randomBytes(32).toString('base64url'), 'a'.repeat(128)])
    assert.equal(secretPathSegment(value), value);
});

test('missing, short, malformed and path-injection secrets still fail closed', () => {
  const valid = randomBytes(32).toString('base64');
  for (const invalid of [
    '', 'short', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(40)}\n`,
    randomBytes(16).toString('base64'), `${valid}=`, ` ${valid}`, `${valid}\n`,
    // Noncanonical pad bits: permissive Base64 decoding alone would accept this.
    `${'A'.repeat(42)}B=`,
    `../${'a'.repeat(40)}`, `${'a'.repeat(40)}?x=1`, `${'a'.repeat(40)}#fragment`,
  ]) assert.throws(() => secretPathSegment(invalid), /TWMCP_SECRET must be/);
});

test('compiled HTTP entry starts, serves SDK requests, and never launches startup browser tests', { timeout: 25_000 }, async () => {
  const reservation = net.createServer();
  await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const raw = randomBytes(32).toString('base64');
  const segment = secretPathSegment(raw);
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, TWMCP_MODE: 'remote-chatgpt', TWMCP_SECRET: raw,
      TWMCP_PUBLIC_CHECK: '1', TWMCP_PUBLIC_ORIGIN: `https://127.0.0.1:${port}`,
      RENDER_EXTERNAL_URL: '', TWMCP_CHROME_PATH: '/nonexistent/chromium',
      TWMCP_SERVE_FIXTURES: '0', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk.toString(); });
  const root = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'render-secret-regression', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${root}/${segment}/mcp`));
  try {
    let health: Response | undefined;
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, 'HTTP entry exited before listening');
      health = await fetch(`${root}/health`).catch(() => undefined);
      if (health?.ok) break;
      await delay(50);
    }
    assert.ok(health?.ok, 'health endpoint did not become ready');
    assert.deepEqual(await health.json(), { ok: true, service: 'twine-play-mcp' });
    assert.equal((await fetch(`${root}/wrong-credential/mcp`)).status, 404);
    assert.equal((await fetch(`${root}/${raw}/mcp`)).status, 404, 'raw Base64 must not create an alias');
    const method = await fetch(`${root}/${segment}/mcp`);
    assert.equal(method.status, 405);
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'twine-play-mcp');
    assert.equal((await client.listTools()).tools.length, 11);
    const result = await client.callTool({ name: 'session', arguments: { action: 'list' } });
    assert.ok(!result.isError);
    assert.ok(result.content);
    assert.ok(output.includes('remote HTTP ready'));
    const report = await (await fetch(`${root}/acceptance.json`)).json();
    assert.equal(report.status, 'NOT_RUN');
    assert.deepEqual(report.checks, []);
    // The previous startup path launched acceptance at 15 seconds. Test an old
    // Render environment retaining the flag, not just a fresh Blueprint.
    await delay(15_200);
    assert.deepEqual(await (await fetch(`${root}/acceptance.json`)).json(), report);
    assert.ok(!output.includes('[public acceptance]'));
    assert.ok(!output.includes(raw) && !output.includes(segment), 'startup must not log credentials');
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(force); }
  }
});
