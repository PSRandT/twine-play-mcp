import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, call, json } from './harness.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

async function probeOwner(h: Awaited<ReturnType<typeof harness>>, sessionId: string) {
  return fetch(h.url, {
    method: 'POST',
    headers: { 'mcp-session-id': sessionId, 'content-type': 'application/json' },
    body: '{}',
  });
}

test('metadata scans and disconnected discovery clients do not block real game play', { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    // ChatGPT can discover tools using connections other than its game client.
    // A normal SDK close is not a remote MCP DELETE, so these owners remain.
    for (let i = 0; i < 3; i++) {
      const { client } = await h.client();
      assert.equal((await client.listTools()).tools.length, 11);
      await client.close();
    }
    const { client: player } = await h.client();
    await call(player, 'session', { action: 'list' });
    const first = await json(player, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    await call(player, 'snapshot', { action: 'save', name: 'before-scans' });
    for (let i = 0; i < 8; i++) {
      const { client, transport } = await h.client();
      await client.listTools();
      assert.equal((await client.callTool({ name: 'observe', arguments: { game_id: first.game_id } })).isError, true);
      await transport.terminateSession();
      await client.close();
    }
    assert.equal((await json(player, 'observe')).text, first.text);
    const next = await json(player, 'choose', { choice: 1 });
    assert.ok(next.step > first.step);
    await call(player, 'snapshot', { action: 'load', name: 'before-scans' });
    assert.equal((await json(player, 'observe')).text, first.text);
    const oldBrowser = [...h.managers[3]!.sessions.values()][0]!.context.browser()!;
    await call(player, 'session', { action: 'close' });
    assert.equal(oldBrowser.isConnected(), false, 'an empty connection must not retain Chrome');
    const reopened = await json(player, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    assert.equal(reopened.text, first.text, 'the same MCP connection can launch a fresh game');
  } finally {
    await h.close();
  }
});

test('bounded connection pool reclaims idle scans while preserving games and snapshots', { timeout: 60_000 }, async () => {
  let clock = 0;
  const h = await harness({ clock: () => clock, sweepMs: 20 });
  try {
    const { client: player } = await h.client();
    const game = await json(player, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    await call(player, 'snapshot', { action: 'save', name: 'keep' });
    const scans = [];
    for (let i = 0; i < 15; i++) scans.push(await h.client());
    await assert.rejects(h.client(), (e: any) => e.code === 429 && /connection capacity/.test(e.message));
    clock = 5001;
    const replacement = await h.client();
    assert.equal((await probeOwner(h, scans[0]!.transport.sessionId!)).status, 404);
    assert.equal((await json(player, 'observe')).text, game.text);
    await call(player, 'choose', { choice: 1 });
    await call(player, 'snapshot', { action: 'load', name: 'keep' });
    assert.equal((await json(player, 'observe')).text, game.text);
    clock = 70_002;
    await delay(100);
    assert.equal((await probeOwner(h, replacement.transport.sessionId!)).status, 404);
    assert.equal((await json(player, 'observe')).text, game.text, 'empty-owner TTL must not expire a game');
  } finally {
    await h.close();
  }
});

test('a pending first game load is not reclaimed as an empty scan', { timeout: 20_000 }, async () => {
  let clock = 0;
  const h = await harness({ clock: () => clock, sweepMs: 20 });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const loading = new Promise<void>((r) => { started = r; });
  try {
    const { client } = await h.client();
    h.managers[0]!.open = async () => {
      started();
      await gate;
      throw new Error('Simulated interrupted page load');
    };
    const pending = client.callTool({ name: 'open_game', arguments: { source: 'https://fixture.example.org/game.html' } });
    await loading;
    for (let i = 0; i < 15; i++) await h.client();
    clock = 70_000;
    await delay(100);
    await h.client();
    release();
    assert.equal((await pending).isError, true);
    assert.equal((await client.listTools()).tools.length, 11, 'busy owner must survive sweep and admission');
  } finally {
    release();
    await h.close();
  }
});

test('initialization rate limit remains bounded, has Retry-After, and recovers', { timeout: 30_000 }, async () => {
  let clock = 0;
  const h = await harness({ clock: () => clock, sweepMs: 1_000_000 });
  try {
    for (let i = 0; i < 60; i++) {
      const { client, transport } = await h.client();
      await transport.terminateSession();
      await client.close();
    }
    await assert.rejects(h.client(), (e: any) => e.code === 429 && /initialization rate limit/.test(e.message));
    const limited = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rate-probe', version: '1' },
      } }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    clock = 60_001;
    const { client } = await h.client();
    assert.equal((await client.listTools()).tools.length, 11);
    await call(client, 'session', { action: 'list' });
  } finally {
    await h.close();
  }
});
