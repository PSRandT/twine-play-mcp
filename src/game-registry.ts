import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RemoteToolRunner } from './remote-profile.js';
import type { RemoteSessionManager } from './remote-session.js';

type GameScope = {
  manager: RemoteSessionManager;
  creator: GameBinding;
  created: number;
  touched: number;
  busy: boolean;
  closing?: Promise<void>;
};
export type GameBinding = {
  games: Set<GameScope>;
  current?: GameScope;
  detached: boolean;
};

const failure = (code: string, message: string): CallToolResult => ({
  isError: true, content: [{ type: 'text', text: `${code}: ${message}` }],
});

/** In-memory games authorized by 256-bit capability handles, not by short ids or
 * the MCP transport. No global enumeration, disk saves or game logic lives here. */
export class GameRegistry {
  private games = new Map<string, GameScope>();
  private scopes = new Set<GameScope>();
  private context = new AsyncLocalStorage<GameScope>();
  private stopped = false;
  readonly manager: RemoteSessionManager;

  constructor(
    private makeManager: () => RemoteSessionManager,
    private clock = Date.now,
    private idleMs = 30 * 60_000,
    private lifetimeMs = 4 * 60 * 60_000,
  ) {
    // Existing upstream handlers run unchanged against exactly one authorized
    // game manager. AsyncLocalStorage keeps concurrent tool calls independent.
    this.manager = new Proxy({} as RemoteSessionManager, {
      get: (_target, key) => {
        const scope = this.context.getStore();
        if (!scope) throw new Error('Game access requires an authorized tool context.');
        const value = Reflect.get(scope.manager, key);
        return typeof value === 'function' ? value.bind(scope.manager) : value;
      },
    });
  }

  bind(): GameBinding { return { games: new Set(), detached: false }; }
  detach(binding: GameBinding) { binding.detached = true; }

  private closeScope(scope: GameScope): Promise<void> {
    if (scope.closing) return scope.closing;
    for (const [id, current] of this.games) if (current === scope) this.games.delete(id);
    scope.closing = Promise.resolve().then(async () => {
      try { await scope.manager.closeAll(); }
      finally {
        this.scopes.delete(scope);
        scope.creator.games.delete(scope);
      }
    });
    return scope.closing;
  }

  async cancel(binding: GameBinding) {
    if (binding.current) await this.closeScope(binding.current);
  }

  async sweep() {
    const now = this.clock();
    await Promise.all([...this.scopes].filter((scope) =>
      now - scope.created > this.lifetimeMs || (!scope.busy && now - scope.touched > this.idleMs),
    ).map((scope) => this.closeScope(scope)));
  }

  runner(binding: GameBinding): RemoteToolRunner {
    return async (name, args, callback) => {
      if (this.stopped || binding.detached)
        return failure('MCP_CONNECTION_CLOSED', 'Reconnect, then pass the existing game_id to continue.');
      let scope: GameScope;
      if (name === 'open_game') {
        if (binding.games.size >= 2) return failure('GAME_LIMIT', 'Maximum two games opened by this connection. Close a game first.');
        // Reserve the scope before awaiting a handler, so pending loads count.
        const now = this.clock();
        scope = { manager: this.makeManager(), creator: binding, created: now, touched: now, busy: false };
        this.scopes.add(scope);
        binding.games.add(scope);
      } else {
        if (typeof args.game_id !== 'string' || !args.game_id) {
          if (name === 'session' && args.action === 'list') return {
            content: [{ type: 'text', text: 'No game handle supplied. Pass the exact game_id from open_game to inspect that game; games are not listed across conversations.' }],
          };
          return failure('GAME_HANDLE_REQUIRED', 'Pass the exact opaque game_id returned by open_game. Do not open a replacement game or guess its id.');
        }
        const found = this.games.get(args.game_id);
        if (!found || found.closing || !found.manager.sessions.has(args.game_id))
          return failure('GAME_NOT_FOUND_OR_EXPIRED', 'The supplied game handle is invalid, closed, expired, or lost after server restart. No action was performed.');
        scope = found;
        if (this.clock() - scope.created > this.lifetimeMs || (!scope.busy && this.clock() - scope.touched > this.idleMs)) {
          await this.closeScope(scope);
          return failure('GAME_NOT_FOUND_OR_EXPIRED', 'This game expired. No action was performed.');
        }
      }
      if (scope.busy) return failure('GAME_BUSY', 'Another operation is running on this game. Wait for its result before the next action.');
      scope.busy = true;
      binding.current = scope;
      try {
        const result = await this.context.run(scope, () => callback(args));
        if (!scope.closing) {
          for (const [id, game] of scope.manager.sessions) {
            if (!/^game_[a-f0-9]{64}$/.test(id)) throw new Error('Remote game credential is not high entropy.');
            this.games.set(id, scope);
            game.journal = game.journal.slice(-200);
          }
        }
        return result;
      } finally {
        scope.busy = false;
        scope.touched = this.clock();
        if (binding.current === scope) binding.current = undefined;
        if (scope.manager.sessions.size === 0) await this.closeScope(scope);
      }
    };
  }

  async close() {
    this.stopped = true;
    await Promise.all([...this.scopes].map((scope) => this.closeScope(scope)));
  }
}
