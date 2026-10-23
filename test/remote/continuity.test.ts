import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, call, json, textOf } from './harness.js';

test('a game survives MCP DELETE and ten steps across independent tool connections', { timeout: 90_000 }, async () => {
  const h = await harness();
  try {
    const opener = await h.client();
    const first = await json(opener.client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    assert.match(first.game_id, /^game_[a-f0-9]{64}$/);
    const page = [...h.managers[0]!.sessions.values()][0]!.page;
    await opener.transport.terminateSession();
    await opener.client.close();
    assert.equal(page.isClosed(), false, 'transport lifetime is not game lifetime');
    let previous = first;
    for (let i = 0; i < 10; i++) {
      const actor = await h.client();
      const choice = i % 2 === 0 ? 'Open the door' : 'Back';
      assert.ok(previous.choices.some((c: any) => c.label === choice));
      const current = await json(actor.client, 'choose', { game_id: first.game_id, choice });
      assert.equal(current.game_id, first.game_id);
      assert.ok(current.step > previous.step);
      await actor.transport.terminateSession();
      await actor.client.close();
      const reader = await h.client();
      assert.equal((await json(reader.client, 'observe', { game_id: first.game_id })).text, current.text);
      await reader.transport.terminateSession();
      await reader.client.close();
      previous = current;
    }
    const viewer = await h.client();
    const shot = await call(viewer.client, 'screenshot', { game_id: first.game_id });
    const image = shot.content.find((part: any) => part.type === 'image') as any;
    assert.equal(image.mimeType, 'image/png');
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);
    await call(viewer.client, 'session', { action: 'close', game_id: first.game_id });
    assert.equal(page.isClosed(), true);
    assert.equal((await viewer.client.callTool({ name: 'observe', arguments: { game_id: first.game_id } })).isError, true);
  } finally { await h.close(); }
});

test('game handles authorize only their game; no enumeration, short-id guessing or fallback', { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const a = await h.client();
    const b = await h.client();
    const stranger = await h.client();
    const gameA = await json(a.client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    const gameB = await json(b.client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    assert.notEqual(gameA.game_id, gameB.game_id);
    const listing = textOf(await stranger.client.callTool({ name: 'session', arguments: { action: 'list' } }));
    assert.ok(!listing.includes(gameA.game_id) && !listing.includes(gameB.game_id));
    for (const handle of [undefined, gameA.game_id.slice(0, 11), 'game_' + '0'.repeat(64),
      gameA.game_id.slice(0, -1) + (gameA.game_id.endsWith('0') ? '1' : '0')]) {
      const result = await stranger.client.callTool({ name: 'choose', arguments: { game_id: handle, choice: 1 } });
      assert.equal(result.isError, true);
      assert.ok(!textOf(result).includes(gameA.game_id) && !textOf(result).includes(gameB.game_id));
    }
    // Possessing the unguessable handle is explicit authorization to resume it.
    const changed = await json(stranger.client, 'choose', { game_id: gameA.game_id, choice: 1 });
    assert.ok(changed.step > gameA.step);
    assert.equal((await json(b.client, 'observe')).text, gameB.text);
    const scopedList = textOf(await stranger.client.callTool({ name: 'session', arguments: { action: 'list', game_id: gameA.game_id } }));
    assert.ok(scopedList.includes(gameA.game_id));
    assert.ok(!scopedList.includes(gameB.game_id));
    await call(stranger.client, 'snapshot', { action: 'save', game_id: gameA.game_id, name: 'branch' });
    assert.equal((await b.client.callTool({ name: 'snapshot', arguments: { action: 'load', name: 'branch', game_id: gameB.game_id } })).isError, true);
  } finally { await h.close(); }
});

test('per-game lock works across transports; expired game handles cannot resurrect state', { timeout: 60_000 }, async () => {
  let clock = 0;
  const h = await harness({ clock: () => clock, idleMs: 1000, sweepMs: 20 });
  try {
    const a = await h.client();
    const b = await h.client();
    const game = await json(a.client, 'open_game', { source: 'https://fixture.example.org/sugarcube.html' });
    const observing = a.client.callTool({ name: 'observe', arguments: { game_id: game.game_id, wait_ms: 500, format: 'json' } });
    await delay(80);
    const blocked = await b.client.callTool({ name: 'choose', arguments: { game_id: game.game_id, choice: 1 } });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /GAME_BUSY/);
    assert.equal(JSON.parse(textOf(await observing)).step, game.step);
    await a.transport.terminateSession();
    clock = 1001;
    await delay(100);
    const fresh = await h.client();
    const expired = await fresh.client.callTool({ name: 'observe', arguments: { game_id: game.game_id } });
    assert.equal(expired.isError, true);
    assert.match(textOf(expired), /GAME_NOT_FOUND_OR_EXPIRED/);
    assert.equal(h.managers[0]!.sessions.size, 0);
  } finally { await h.close(); }
});
