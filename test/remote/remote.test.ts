import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, call, json, textOf } from './harness.js';
import { REMOTE_TOOLS } from '../../src/remote-profile.js';
import { isPublicAddress, publicHttpsUrl, resolvePublic } from '../../src/network-policy.js';

for (const ip of [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '0.0.0.0',
  '100.64.0.1',
  '224.0.0.1',
  '240.0.0.1',
  '192.0.2.1',
  '198.51.100.1',
  '203.0.113.1',
  '::1',
  '::',
  'fc00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '64:ff9b::7f00:1',
  '2002:7f00:1::',
  '2001:db8::1',
]) {
  test(`network block ${ip}`, () => assert.equal(isPublicAddress(ip), false));
}
test('global addresses allowed and local URLs rejected', async () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true);
  for (const source of [
    '/etc/passwd',
    './game.html',
    'C:\\Games\\game.html',
    'file:///etc/passwd',
    'http://example.org',
    'https://localhost',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://10.0.0.1',
    'https://foo.local',
    'https://user:pass@example.org',
    'https://example.org:8443',
  ])
    assert.throws(() => publicHttpsUrl(source));
  assert.equal(publicHttpsUrl('https://example.org/game.html').hostname, 'example.org');
  await assert.rejects(resolvePublic('localhost'));
});

test(
  'official SDK: 11 tools, four real formats, screenshots, snapshots, 10 choices, isolation, security',
  { timeout: 180_000 },
  async () => {
    const h = await harness();
    try {
      const { client: a } = await h.client();
      const { client: b } = await h.client();
      assert.equal(a.getServerVersion()?.name, 'twine-play-mcp');
      const listed = (await a.listTools()).tools;
      assert.deepEqual(listed.map((t) => t.name).sort(), [...REMOTE_TOOLS].sort());
      for (const tool of listed) {
        assert.ok(tool.description);
        assert.ok(tool.annotations);
        assert.equal(
          tool.annotations.readOnlyHint,
          ['observe', 'find_ui', 'get_variables', 'screenshot'].includes(tool.name),
        );
        assert.equal(tool.annotations.openWorldHint, tool.name === 'open_game');
      }
      assert.equal(listed.find((t) => t.name === 'screenshot')!.inputSchema.properties!.path, undefined);
      assert.equal(listed.find((t) => t.name === 'choose')!.inputSchema.properties!.allow_external, undefined);
      const initialB = await json(b, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
      for (const format of ['sugarcube', 'harlowe', 'snowman', 'chapbook']) {
        const initial = await json(a, 'open_game', { source: `https://fixture.example.org/${format}.html` });
        assert.equal(initial.format, format);
        assert.ok(initial.text.length);
        assert.ok(initial.choices.length >= 2);
        assert.equal((await json(a, 'observe')).text, initial.text);
        const beforeShot: any = await call(a, 'screenshot');
        const next = await json(a, 'choose', { choice: 1 });
        assert.notEqual(next.text, initial.text);
        assert.ok(next.step > initial.step);
        const shot = await call(a, 'screenshot');
        const img: any = shot.content.find((c: any) => c.type === 'image');
        assert.notEqual(img.data, beforeShot.content.find((c: any) => c.type === 'image').data);
        assert.equal(img.mimeType, 'image/png');
        const png = Buffer.from(img.data, 'base64');
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), 1280);
        assert.equal(png.readUInt32BE(20), 800);
        if (format === 'sugarcube') {
          await call(a, 'navigate', { action: 'back' });
          await call(a, 'snapshot', { action: 'save', name: 'branch' });
          const varsBefore = textOf(await call(a, 'get_variables', { paths: ['coins'] }));
          const branchA = await json(a, 'choose', { choice: 1 });
          await call(a, 'snapshot', { action: 'load', name: 'branch' });
          const branchB = await json(a, 'choose', { choice: 2 });
          assert.notEqual(branchB.text, branchA.text);
          assert.notEqual(textOf(await call(a, 'get_variables', { paths: ['coins'] })), varsBefore);
          await call(a, 'snapshot', { action: 'load', name: 'branch' });
          assert.equal(textOf(await call(a, 'get_variables', { paths: ['coins'] })), varsBefore);
          let last = await json(a, 'observe');
          for (let i = 0; i < 10; i++) {
            const choice = i % 2 === 0 ? 'Open the door' : 'Back';
            assert.ok(last.choices.some((c: any) => c.label === choice));
            const n = await json(a, 'choose', { choice });
            assert.ok(n.step > last.step);
            assert.notEqual(n.text, last.text);
            last = n;
            assert.equal((await json(a, 'observe')).text, last.text);
          }
          assert.equal((await a.callTool({ name: 'observe', arguments: { game_id: initialB.game_id.slice(0, 11) } })).isError, true);
          assert.equal((await json(b, 'observe')).text, initialB.text);
          assert.equal(
            (await b.callTool({ name: 'snapshot', arguments: { action: 'load', name: 'branch' } })).isError,
            true,
          );
          assert.equal(
            (await a.callTool({ name: 'choose', arguments: { choice: 1, allow_external: true } })).isError,
            true,
          );
          assert.equal((await a.callTool({ name: 'screenshot', arguments: { path: '/tmp/leak.png' } })).isError, true);
          assert.equal(
            (await a.callTool({ name: 'navigate', arguments: { action: 'goto', target: 'End' } })).isError,
            true,
          );
        }
        await call(a, 'session', { action: 'close' });
      }
      for (const source of [
        '/etc/passwd',
        'C:\\game.html',
        'file:///etc/passwd',
        'http://127.0.0.1',
        'http://localhost',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://169.254.169.254',
        'https://[::1]',
        'https://fixture.example.org/redirect',
      ]) {
        assert.equal((await a.callTool({ name: 'open_game', arguments: { source } })).isError, true, source);
      }
      assert.equal(
        (
          await a.callTool({
            name: 'open_game',
            arguments: { source: 'https://fixture.example.org/external-redirect' },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await json(a, 'open_game', { source: 'https://fixture.example.org/redirect-ok' })).format,
        'sugarcube',
      );
      await call(a, 'session', { action: 'close' });
      await json(a, 'open_game', { source: 'https://fixture.example.org/malicious' });
      await delay(250);
      assert.equal(
        h.requests.some((p) => p.includes('/private') || p.includes('/latest')),
        false,
      );
      assert.ok(h.blocked.includes('private.example.org'));
      assert.equal(
        h.hosts.includes('other.example.org'),
        false,
        'external redirect/popup must not reach the other origin',
      );
      assert.equal((await a.callTool({ name: 'choose', arguments: { choice: 1 } })).isError, true);
      await call(a, 'session', { action: 'close' });
      await call(a, 'open_game', { source: 'https://fixture.example.org/controls' });
      const controls = await json(a, 'observe');
      const input = controls.inputs.find((i: any) => i.name === 'player');
      assert.ok(input);
      const filled = await json(a, 'interact', { ref: input.ref, value: 'MCP player' });
      assert.ok(filled.step > controls.step);
      assert.equal(filled.inputs.find((i: any) => i.name === 'player').value, 'MCP player');
      const submitted = await json(a, 'click_ui', { text: 'Submit' });
      assert.match(submitted.text, /MCP player/);
      assert.ok(submitted.step > filled.step);
      assert.match(textOf(await call(a, 'find_ui', { text: 'Submit' })), /Found 1/);
      await call(a, 'session', { action: 'close' });
      assert.equal((await fetch(h.root + '/mcp')).status, 404);
      assert.equal((await fetch(h.url)).status, 405);
      assert.equal(
        (
          await fetch(h.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
            body: '{}',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(h.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'x'.repeat(33000),
          })
        ).status,
        413,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'two game cap, explicit game close, transport reconnection and idle cleanup',
  { timeout: 60000 },
  async () => {
    const h = await harness({ sweepMs: 50, idleMs: 30_000, lifetimeMs: 30_000 });
    try {
      const { client, transport } = await h.client();
      const game1 = await json(client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
      const manager = h.managers[0]!;
      const first = [...manager.sessions.values()][0]!;
      await call(client, 'snapshot', { action: 'save', name: 'temporary' });
      const game2 = await json(client, 'open_game', { source: 'https://fixture.example.org/harlowe.html' });
      assert.equal(
        (
          await client.callTool({
            name: 'open_game',
            arguments: { source: 'https://fixture.example.org/snowman.html' },
          })
        ).isError,
        true,
      );
      await call(client, 'session', { action: 'close', game_id: game1.game_id });
      await call(client, 'session', { action: 'close', game_id: game2.game_id });
      assert.equal(manager.sessions.size, 0);
      assert.equal(first.page.isClosed(), true);
      assert.equal(first.snapshots.size, 0);
      const game3 = await json(client, 'open_game', { source: 'https://fixture.example.org/chapbook.html' });
      const active = [...h.managers[2]!.sessions.values()][0]!;
      await transport.terminateSession();
      await delay(50);
      assert.equal(active.page.isClosed(), false);
      const resumed = await h.client();
      assert.equal((await json(resumed.client, 'observe', { game_id: game3.game_id })).text, game3.text);
      await call(resumed.client, 'session', { action: 'close', game_id: game3.game_id });
      assert.equal(active.page.isClosed(), true);
    } finally {
      await h.close();
    }
    const idle = await harness({ idleMs: 100, sweepMs: 20 });
    try {
      const { transport } = await idle.client();
      await delay(200);
      assert.equal(
        (
          await fetch(idle.url, {
            method: 'POST',
            headers: { 'mcp-session-id': transport.sessionId!, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
    } finally {
      await idle.close();
    }
  },
);

test('rate limiting, hard lifetime and aborted tool request close owned contexts', { timeout: 60000 }, async () => {
  let clock = 0;
  const h = await harness({ lifetimeMs: 1600, sweepMs: 20, clock: () => clock });
  try {
    const { client, transport } = await h.client();
    for (let i = 0; i < 117; i++) await client.listTools();
    await call(client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    const page = [...h.managers[0]!.sessions.values()][0]!.page;
    let limited = false;
    for (let i = 0; i < 5; i++) {
      try {
        await client.listTools();
      } catch {
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
    clock = 2000;
    await delay(250);
    assert.equal(page.isClosed(), true);
    assert.equal(h.managers[0]!.sessions.size, 0);
  } finally {
    await h.close();
  }
  const aborted = await harness();
  try {
    const { client, transport } = await aborted.client();
    await call(client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    const page = [...aborted.managers[0]!.sessions.values()][0]!.page;
    const controller = new AbortController();
    const request = fetch(aborted.url, {
      method: 'POST',
      headers: {
        'mcp-session-id': transport.sessionId!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1234,
        method: 'tools/call',
        params: { name: 'observe', arguments: { game_id: [...aborted.managers[0]!.sessions.keys()][0], wait_ms: 10000 } },
      }),
      signal: controller.signal,
    }).catch(() => {});
    await delay(150);
    controller.abort();
    await request;
    await delay(250);
    assert.equal(page.isClosed(), true);
    assert.equal(aborted.managers[0]!.sessions.size, 0);
  } finally {
    await aborted.close();
  }
});
