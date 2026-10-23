import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createEgressProxy } from '../../src/egress-proxy.js';
import { resolvePublic } from '../../src/network-policy.js';

test('DNS answer validation rejects mixed public/private, IPv6 and rebinding', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1']) {
    await assert.rejects(resolvePublic('public.example', async () => [{ address: '8.8.8.8' }, { address }]));
  }
  let lookups = 0;
  const resolver = async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1' }];
  assert.deepEqual(await resolvePublic('rebind.example', resolver), ['8.8.8.8']);
  await assert.rejects(resolvePublic('rebind.example', resolver));
});
test('CONNECT pins validated IP; rebind and insecure CONNECT cannot dial', async () => {
  let lookups = 0;
  const dialed: string[] = [];
  const echo = net.createServer((s) => s.end('fixture'));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  const proxy = await createEgressProxy({
    resolve: async () => [++lookups === 1 ? '8.8.8.8' : '127.0.0.1'],
    connect: (ip) => {
      dialed.push(ip);
      return net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1');
    },
  });
  const request = (destination: string) =>
    new Promise<string>((resolve, reject) => {
      const u = new URL(proxy.url);
      const client = net.connect(Number(u.port), u.hostname);
      let body = '';
      client.on('error', reject);
      client.on('data', (d) => (body += d.toString()));
      client.on('close', () => resolve(body));
      client.on('connect', () => client.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`));
    });
  try {
    assert.match(await request('public.example.org:443'), /200 Connection Established/);
    assert.match(await request('public.example.org:443'), /403 Forbidden/);
    assert.match(await request('127.0.0.1:443'), /403 Forbidden/);
    assert.match(await request('public.example.org:80'), /403 Forbidden/);
    assert.deepEqual(dialed, ['8.8.8.8']);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => echo.close(() => r()));
  }
});
