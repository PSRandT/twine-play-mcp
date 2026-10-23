import { remoteRegistrar, REMOTE_INSTRUCTIONS, type RemoteToolRunner } from './remote-profile.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SessionManager, type ChoiceInfo, type DialogInfo, type GameSession, type Observation } from './session.js';
import { renderConsole, renderObservation, renderOpen, renderSnapshotList } from './render.js';
import { claimAutoOpen, claimFirstReport, forgetLiveView, liveViewUrl, openInBrowser } from './live-view.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Version reported to MCP clients, read from package.json so it can never drift from the
 * published version. Works from both dist/server.js and src/server.ts (tsx): the package
 * root is one level above either directory.
 */
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const text = (body: string, isError = false): TextResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {})
});

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const errorText = (error: string, message?: string): TextResult =>
  text(`ERROR: ${error}${message ? ` — ${message}` : ''}`, true);

/**
 * Compact error: the message, an optional hint, what the agent can act on right now, and — when
 * the failure was a bad/ambiguous session — the sessions that do exist. Never a full observation.
 */
function errResult(
  code: string,
  message?: string,
  extra?: {
    hint?: string;
    choices?: ChoiceInfo[];
    dialog?: DialogInfo | null;
    passage?: string | null;
    games?: Array<{ id: string; title: string }>;
  }
): TextResult {
  const lines = [`ERROR: ${code}${message ? ` — ${message}` : ''}`];
  if (extra?.hint) lines.push(`Hint: ${extra.hint}`);
  if (extra?.passage) lines.push(`(still at passage: ${extra.passage})`);
  const cs = extra?.choices ?? [];
  if (cs.length) {
    const shown = cs
      .slice(0, 12)
      .map((c, i) => `${i + 1}) ${oneLine(c.label)}${c.disabled ? ' (disabled)' : ''}${c.dialog ? ' [dialog]' : ''}`);
    lines.push(`Available choices: ${shown.join('  ')}${cs.length > 12 ? `  … +${cs.length - 12} more` : ''}`);
  }
  if (extra?.dialog?.buttons?.length) {
    lines.push('Dialog buttons: ' + extra.dialog.buttons.map((b) => `${b.n}) ${oneLine(b.label)}`).join('  '));
  }
  if (extra?.games?.length) {
    lines.push('Open games: ' + extra.games.map((g) => `${g.id} (${g.title})`).join('  '));
  }
  return text(lines.join('\n').slice(0, 2500), true);
}

/** Structured observation for format:"json" callers (returned as a JSON string; use JSON.parse). */
function jsonPayload(session: GameSession, obs: Observation, action?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: true,
    game_id: session.id,
    passage: obs.passage,
    format: obs.format,
    step: session.step,
    engineState: obs.engineState,
    text: obs.text,
    choices: obs.choices.map((c, i) => ({
      n: i + 1,
      label: c.label,
      target: c.target,
      dialog: !!c.dialog,
      disabled: !!c.disabled,
      external: !!c.external
    })),
    inputs: obs.inputs.map((i) => ({
      ref: i.ref,
      kind: i.kind,
      label: i.label ?? null,
      name: i.name,
      value: i.value,
      checked: i.checked ?? null,
      dialog: !!i.dialog
    })),
    inputsTotal: obs.inputsTotal ?? obs.inputs.length,
    inputsOffset: obs.inputsOffset ?? 0,
    ui: obs.ui.map((u) => ({ ref: u.ref, label: u.label })),
    uiTotal: obs.uiTotal ?? obs.ui.length,
    dialog: obs.dialog ? { title: obs.dialog.title, text: obs.dialog.text, buttons: obs.dialog.buttons } : null,
    status: obs.status,
    action: action ?? null
  });
}

function observationResult(
  session: GameSession,
  obs: Observation,
  opts: { format?: 'text' | 'json'; prefix?: string; sinceLast?: boolean; previous?: Observation | null; action?: Record<string, unknown> } = {}
): TextResult {
  if (opts.format === 'json') return text(jsonPayload(session, obs, opts.action));
  const body = observationText(session, obs, opts.sinceLast ?? false, opts.previous ?? null);
  return text((opts.prefix ? opts.prefix + '\n\n' : '') + body);
}

const formatParam = z.enum(['text', 'json']).optional().describe('"text" (default) or "json".');

/**
 * `game_id` is optional everywhere: with one open game it carries no information. It is only
 * needed when several games are open at once, and then the error names the candidates.
 */
const gameIdParam = z.string().optional().describe('Session id from open_game. Omit when a single game is open.');

/** Turn any thrown error into a tool result, listing the open games when the id was the problem. */
function fromError(manager: SessionManager, code: string, err: unknown): TextResult {
  const message = String((err as Error)?.message ?? err);
  const games = manager.listSessions().map((s) => ({ id: s.id, title: s.title }));
  const sessionish = /game_id|Unknown game_id|open games/i.test(message);
  return errResult(code, message, sessionish ? { games, hint: 'Call open_game, or pass game_id explicitly.' } : undefined);
}

function consoleErrors(session: GameSession): number {
  return session.console.filter((c) => c.type !== 'warning').length;
}

function observationText(session: GameSession, obs: Observation, sinceLast: boolean, previous: Observation | null): string {
  return renderObservation(obs, {
    step: session.step,
    consoleCount: consoleErrors(session),
    sinceLast,
    previous
  });
}

export function buildServer(manager: SessionManager, profile: 'local' | 'remote-chatgpt' = 'local', run?: RemoteToolRunner): McpServer {
  const server = new McpServer(
    { name: 'twine-play-mcp', version: VERSION },
    {
      instructions: profile === 'remote-chatgpt' ? REMOTE_INSTRUCTIONS :
        'DISPLAY POLICY — how to let the user watch a game (follow this to avoid stacking windows on their screen):\n' +
        '• Show at most ONE view per game. Pick exactly one method; never combine them.\n' +
        '• Default: call live_view(game_id) and give the user the returned URL; pass open:true only if they asked you to open it for them. Auto-open happens at most once per game.\n' +
        '• Only if the user explicitly asks for a real browser window: open_game with headless:false. Do not also open a live view for the same game.\n' +
        '• screenshot is a one-shot visual check, never a stream — do not loop it to "show" the user the game.\n' +
        '• If a view is already open, reuse it (live_view returns the same URL without launching anything new).\n' +
        'GAME ID: game_id is optional while exactly one game is open — omit it for less noise.'
    }
  );

  const register = profile === 'remote-chatgpt' ? remoteRegistrar(server, run) : server.registerTool.bind(server);

  register(
    'open_game',
    {
      title: 'Open a Twine game',
      description:
        'Open a Twine / interactive-fiction game and return the first observation. Accepts a local .html file, a folder, or an http(s) URL. Local games are served over 127.0.0.1 so saves work.',
      inputSchema: {
        source: z.string().describe('Path to a .html file or folder, or an http(s) URL.'),
        headless: z.boolean().optional().describe('Run headless (default true). Set false only to show a real browser window.'),
        seed: z.string().optional().describe('Seed the SugarCube PRNG for reproducible runs.'),
        wait_timeout_ms: z.number().int().min(1000).max(120000).optional().describe('How long to wait for the game to settle (default 20000).'),
        format: formatParam
      }
    },
    async ({ source, headless, seed, wait_timeout_ms, format }) => {
      try {
        const session = await manager.open({
          source,
          headless: headless ?? true,
          seed,
          waitTimeoutMs: wait_timeout_ms,
          blockTrackers: process.env.TWMCP_BLOCK_TRACKERS !== '0'
        });
        const obs = session.lastObservation;
        if (!obs) return errorText('no-observation', 'Game loaded but produced no observation.');
        if (format === 'json') return observationResult(session, obs, { format });
        return text(
          renderOpen(session, obs) + '\n\nTip: choose(1) clicks the first choice; every action returns a fresh observation.'
        );
      } catch (err) {
        return errorText('open-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  register(
    'observe',
    {
      title: 'Observe the game (optionally waiting)',
      description:
        'Read the current passage: text, choices, inputs, dialog, status. Pass for_text or wait_ms to wait first — timed passages need no second call. Inputs are paginated in windows of 40.',
      inputSchema: {
        game_id: gameIdParam,
        since_last: z.boolean().optional().describe('Return just a "no change" note when nothing changed (default true; ignored for json).'),
        for_text: z.string().optional().describe('Wait until this text appears anywhere on the page, then observe.'),
        wait_ms: z.number().int().min(0).max(120000).optional().describe('Wait this long before observing (also the timeout for for_text, default 15000).'),
        include_variables: z.boolean().optional().describe('Embed story variables (default false).'),
        max_text_chars: z.number().int().min(200).max(100000).optional().describe('Cap passage text length (default 12000).'),
        inputs_offset: z.number().int().min(0).max(1000).optional().describe('Skip this many inputs before listing (default 0).'),
        inputs_limit: z.number().int().min(1).max(500).optional().describe('How many inputs to list (default 40).'),
        format: formatParam
      }
    },
    async ({ game_id, since_last, for_text, wait_ms, include_variables, max_text_chars, inputs_offset, inputs_limit, format }) => {
      try {
        const session = manager.resolve(game_id);
        const previous = session.lastObservation;
        if (for_text !== undefined || wait_ms !== undefined) {
          const res = await manager.wait(session, { ms: wait_ms, forText: for_text, timeoutMs: wait_ms });
          const note = for_text
            ? res.matched
              ? `Text found after ${res.waitedMs}ms.`
              : `Text NOT found within ${res.waitedMs}ms.`
            : `Waited ${res.waitedMs}ms.`;
          return observationResult(session, res.observation ?? (await manager.observe(session)), { format, prefix: note });
        }
        const obs = await manager.observe(session, {
          includeVariables: include_variables ?? false,
          includeStatus: true,
          maxTextChars: max_text_chars ?? 12000,
          inputsOffset: inputs_offset ?? 0,
          inputsLimit: inputs_limit ?? 40
        });
        return observationResult(session, obs, { format, sinceLast: since_last ?? true, previous });
      } catch (err) {
        return fromError(manager, 'observe-failed', err);
      }
    }
  );

  register(
    'choose',
    {
      title: 'Click a choice',
      description:
        'Click a passage choice by 1-based number from the last observation, or by (partial) label. Numbered choices include dialog buttons (tagged [dialog]). Pass expected to guard against clicking the wrong link.',
      inputSchema: {
        game_id: gameIdParam,
        choice: z.union([z.number(), z.string()]).describe('1-based number from the last observation, or label text (case-insensitive, may be partial).'),
        expected: z.string().optional().describe('Substring the clicked label must contain; fails safely if it does not match.'),
        allow_external: z.boolean().optional().describe('Allow links that leave the game (default false, they are blocked).'),
        format: formatParam
      }
    },
    async ({ game_id, choice, expected, allow_external, format }) => {
      try {
        const session = manager.resolve(game_id);
        const res = await manager.choose(session, choice, expected, allow_external ?? false);
        if (!res.ok) {
          const last = session.lastObservation;
          const hints: Record<string, string> = {
            'no-such-choice': 'Use a number from the last observation, or observe() to refresh labels. Dialog buttons are listed with [dialog].',
            'bad-index': 'Number must be within 1..N of the last observation.',
            'stale-ref': 'The passage changed; call observe() and retry.',
            'ambiguous-choice': 'Use the 1-based number instead of a short label.',
            'external-link-blocked': 'Pass allow_external=true if the link is intended.',
            'expectation-failed': 'The label did not contain the expected text; nothing was clicked.'
          };
          return errResult(res.error ?? 'choose-failed', res.message, {
            hint: hints[res.error ?? ''] ?? 'Call observe() to see the current choices.',
            choices: last?.choices,
            dialog: last?.dialog ?? null,
            passage: last?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, {
          format,
          prefix: `Clicked: "${res.clicked?.label ?? ''}"${res.clicked?.target ? ` -> ${res.clicked.target}` : ''}`,
          action: { label: res.clicked?.label ?? null, target: res.clicked?.target ?? null, kind: res.clicked?.kind ?? null }
        });
      } catch (err) {
        return fromError(manager, 'choose-failed', err);
      }
    }
  );

  register(
    'click_ui',
    {
      title: 'Click UI outside the passage',
      description:
        'Click sidebar buttons and menus by ref, CSS selector or visible text. Text matching covers <label> controls (SugarCube radio/checkbox options). Use choose() for numbered passage choices.',
      inputSchema: {
        game_id: gameIdParam,
        ref: z.string().optional().describe('UI ref from an observation (e.g. "u1" or "x3").'),
        text: z.string().optional().describe('Visible text of the target (case-insensitive, partial).'),
        selector: z.string().optional().describe('CSS selector, if you know the exact element.'),
        exact: z.boolean().optional().describe('Require an exact text match (default false).'),
        format: formatParam
      }
    },
    async ({ game_id, ref, text: uiText, selector, exact, format }) => {
      try {
        const session = manager.resolve(game_id);
        if (!ref && !uiText && !selector) return errorText('missing-argument', 'Provide ref, text or selector.');
        const res = await manager.clickUi(session, { ref, text: uiText, selector, exact });
        if (!res.ok) {
          return errResult(res.error ?? 'no-match', res.message, {
            hint:
              res.error === 'stale-ref'
                ? 'Refs are refreshed by observe(); call observe() again or use find_ui(text).'
                : 'Locate the control with find_ui(text) or pass a CSS selector.',
            choices: session.lastObservation?.choices,
            passage: session.lastObservation?.passage ?? null
          });
        }
        const note = `Clicked UI: ${res.label ?? '(element)'}${res.matches && res.matches > 1 ? ` (${res.matches} matches; alternatives: ${(res.alternatives ?? []).slice(0, 4).join(' | ')})` : ''}`;
        return observationResult(session, res.observation!, { format, prefix: note, action: { label: res.label ?? null } });
      } catch (err) {
        return fromError(manager, 'click-ui-failed', err);
      }
    }
  );

  register(
    'interact',
    {
      title: 'Fill an input or press a key',
      description:
        'Set an input/textarea/select by ref, or press a key ("Enter", "ArrowUp"). Radios/checkboxes take "true"/"false". Refs come from the last observation or find_ui.',
      inputSchema: {
        game_id: gameIdParam,
        ref: z.string().optional().describe('Input ref from the last observation (e.g. "i1"). Optional when only pressing a key.'),
        value: z.string().optional().describe('Value to set. Radios/checkboxes: "true" or "false".'),
        key: z.string().optional().describe('Keyboard key to press, e.g. "Enter", "a", "ArrowDown".'),
        format: formatParam
      }
    },
    async ({ game_id, ref, value, key, format }) => {
      try {
        const session = manager.resolve(game_id);
        if (!ref && !key) return errorText('missing-argument', 'Provide ref (with value) and/or key.');
        if (key) {
          const res = await manager.press(session, key, ref);
          return observationResult(session, res.observation!, { format, prefix: `Pressed "${key}".` });
        }
        const res = await manager.interact(session, ref!, value);
        if (!res.ok) {
          return errResult(res.error ?? 'interact-failed', res.message, {
            hint:
              res.error === 'stale-ref'
                ? 'Refs are refreshed by every observe(); call observe() and use the new ref (or find_ui to locate it).'
                : 'Check the input ref in the last observation; find_ui(text) can locate controls by label.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Set ${ref} = "${value ?? ''}".` });
      } catch (err) {
        return fromError(manager, 'interact-failed', err);
      }
    }
  );

  register(
    'navigate',
    {
      title: 'Move through the story (back / restart / goto)',
      description:
        'back: undo one passage (SugarCube/Harlowe). restart: start over, optionally reseeded. goto: jump straight to a named passage — QA only, it skips the path there.',
      inputSchema: {
        game_id: gameIdParam,
        action: z.enum(['back', 'restart', 'goto']).describe('What to do.'),
        target: z.string().optional().describe('Passage name for action:"goto".'),
        seed: z.string().optional().describe('New SugarCube PRNG seed for action:"restart".'),
        format: formatParam
      }
    },
    async ({ game_id, action, target, seed, format }) => {
      try {
        const session = manager.resolve(game_id);
        if (action === 'back') {
          const res = await manager.back(session);
          if (!res.ok) {
            return errResult(res.error ?? 'back-failed', res.message, {
              hint: 'Only SugarCube (Engine.backward) and Harlowe (sidebar undo) can go back. Save a snapshot before risky branches instead.',
              passage: session.lastObservation?.passage ?? null
            });
          }
          return observationResult(session, res.observation!, { format, prefix: 'Went back one step.' });
        }
        if (action === 'restart') {
          const res = await manager.restart(session, seed);
          return observationResult(session, res.observation!, {
            format,
            prefix: `Restarted${res.seeded ? ` with seed "${seed}"` : ''}.`
          });
        }
        if (!target) return errorText('missing-argument', 'action:"goto" needs target (a passage name).');
        const res = await manager.goTo(session, target);
        if (!res.ok) {
          return errResult(res.error ?? 'goto-failed', res.message, {
            hint: 'goto needs a story format with a jump API (SugarCube Engine.play, Snowman story.show, Harlowe Engine.goTo).',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Jumped to "${target}".` });
      } catch (err) {
        return fromError(manager, 'navigate-failed', err);
      }
    }
  );

  register(
    'snapshot',
    {
      title: 'In-session snapshots (save / load / list)',
      description:
        'Branch exploration: save stores the current state under a name, load restores it, list shows what exists. Native on SugarCube, Chapbook and Snowman; Harlowe reports unsupported.',
      inputSchema: {
        game_id: gameIdParam,
        action: z.enum(['save', 'load', 'list']).describe('save, load or list.'),
        name: z.string().optional().describe('Snapshot name (default "default"; required for save/load).'),
        format: formatParam
      }
    },
    async ({ game_id, action, name, format }) => {
      try {
        const session = manager.resolve(game_id);
        const key = name ?? 'default';
        if (action === 'list') {
          return text(renderSnapshotList(session.id, manager.listSnapshots(session)));
        }
        if (action === 'save') {
          const res = await manager.saveState(session, key);
          if (!res.ok) {
            return errResult(res.error ?? 'save-failed', res.message, {
              hint: 'No snapshot API for this story format — use a before/after variable diff via get_variables instead.'
            });
          }
          const names = manager.listSnapshots(session).map((s) => s.name);
          return text(`Saved snapshot "${key}" (${res.bytes} chars). Snapshots: ${names.join(', ')}.`);
        }
        const res = await manager.loadState(session, key);
        if (!res.ok) {
          return errResult(res.error ?? 'load-failed', res.message, {
            hint: 'Call snapshot(action:"list") to see the names that exist.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Loaded snapshot "${key}".` });
      } catch (err) {
        return fromError(manager, 'snapshot-failed', err);
      }
    }
  );

  register(
    'find_ui',
    {
      title: 'Find a control, input or panel',
      description:
        'Find visible controls (buttons, links, labels, inputs) by text and/or input name; returns refs for click_ui/interact. Pass selector to inspect one DOM subtree, or discover:true to list overlay panels (mod GUIs).',
      inputSchema: {
        game_id: gameIdParam,
        text: z.string().optional().describe('Label text to search for (case-insensitive, partial by default).'),
        exact: z.boolean().optional().describe('Require an exact label match (default false).'),
        kind: z.string().optional().describe('Filter by kind: button, link, label, input, radio, checkbox, select, textarea.'),
        name: z.string().optional().describe('Filter by input name attribute (exact).'),
        selector: z.string().optional().describe('Inspect this DOM subtree instead of searching by text.'),
        discover: z.boolean().optional().describe('Without text/name/selector: list overlay panels that contain buttons or file inputs.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matches to return (default 20).')
      }
    },
    async ({ game_id, text: q, exact, kind, name, selector, discover, limit }) => {
      try {
        const session = manager.resolve(game_id);
        // Panel inspection / discovery shares this tool: one "find things in the UI" entry point.
        if (selector || (discover && !q && !name)) {
          const res = await manager.inspectUi(session, selector);
          if (!res.ok) return fromError(manager, 'inspect-failed', res.error ?? res.message);
          if (!selector) {
            const cands = (res.candidates ?? []) as Array<Record<string, unknown>>;
            if (!cands.length) return text('No overlay panels discovered. Pass selector to inspect a specific element.');
            return text(
              'Panels:\n' +
                cands
                  .map(
                    (c, i) =>
                      `${i + 1}. ${c.frame ? '[iframe] ' : ''}${c.selector} — ${c.buttons} buttons, ${c.inputs} inputs, ${c.fileInputs} file inputs: ${String(c.text ?? '').slice(0, 90)}`
                  )
                  .join('\n') +
                '\n\nTip: upload_file without file_input searches all frames; click_ui by text also works inside iframes.'
            );
          }
          const lines = [`# ${res.selector}${res.frame ? ' (iframe)' : ''}`, res.text ?? ''];
          if (res.buttons?.length) {
            lines.push('', 'Buttons:');
            res.buttons.forEach((b, i) => lines.push(`  ${i + 1}. ${b.label}${b.ref ? ` [${b.ref}]` : ' (use click_ui text)'}`));
          }
          if (res.inputs?.length) {
            lines.push('', 'Inputs:');
            for (const inp of res.inputs) {
              lines.push(
                `  ${inp.ref || '(file input — use upload_file)'} ${inp.kind}${inp.label ? ` "${inp.label.slice(0, 40)}"` : ''}${inp.name ? ` name="${inp.name}"` : ''}${inp.value ? ` value="${String(inp.value).slice(0, 40)}"` : ''}` +
                  (inp.checked !== undefined ? ` checked=${inp.checked}` : '')
              );
            }
          }
          return text(lines.join('\n'));
        }

        if (!q && !name) return errorText('missing-argument', 'Provide text and/or name; or selector / discover:true for panels.');
        const res = await manager.findUi(session, { text: q, exact, kind, name, limit });
        if (!res.ok) return fromError(manager, 'find-failed', res.error ?? res.message);
        const matches = res.matches ?? [];
        if (!matches.length) {
          return text(
            `No visible control matches${q ? ` "${q}"` : ''}${name ? ` name="${name}"` : ''}. ` +
              'Try observe() for numbered inputs/choices, or find_ui(discover:true) for panels.'
          );
        }
        const lines = [
          `Found ${matches.length}${res.total && res.total > matches.length ? ` of ${res.total}` : ''} control(s) — click_ui(ref) to click, interact(ref, value) to set:`
        ];
        for (const m of matches) {
          const bits = [`[${m.ref}]`, m.kind];
          if (m.label) bits.push(`"${m.label.slice(0, 50)}"`);
          if (m.name) bits.push(`name="${m.name}"`);
          if (m.checked !== undefined) bits.push(m.checked ? '[checked]' : '[unchecked]');
          if (m.disabled) bits.push('(disabled)');
          if (m.value) bits.push(`value="${m.value.slice(0, 40)}"`);
          lines.push('  ' + bits.join(' '));
        }
        return text(lines.join('\n'));
      } catch (err) {
        return fromError(manager, 'find-failed', err);
      }
    }
  );

  register(
    'get_variables',
    {
      title: 'Read story variables',
      description:
        'Read SugarCube State.variables by dot path, e.g. ["haircolour", "player.background"]; "V.x" and "variables.x" also work. No paths: shallow top-level key summary. Other formats have no readable store.',
      inputSchema: {
        game_id: gameIdParam,
        paths: z.array(z.string()).max(50).optional().describe('Dot paths to read (default: top-level key summary).')
      }
    },
    async ({ game_id, paths }) => {
      try {
        const session = manager.resolve(game_id);
        const res = await manager.getVariables(session, paths);
        if (!res.ok) {
          return errResult(res.error ?? 'variables-failed', res.message, {
            hint: 'get_variables needs SugarCube. For Snowman/Chapbook use observe(include_variables:true) or a snapshot.'
          });
        }
        return text(JSON.stringify(res));
      } catch (err) {
        return fromError(manager, 'variables-failed', err);
      }
    }
  );

  register(
    'get_logs',
    {
      title: 'Read console errors and the play journal',
      description:
        'console: JS exceptions, console errors and HTTP failures from the page (QA). journal: passages visited and choices taken. all (default): both.',
      inputSchema: {
        game_id: gameIdParam,
        kind: z.enum(['console', 'journal', 'all']).optional().describe('Which log to read (default "all").'),
        clear: z.boolean().optional().describe('Clear the selected log after reading (default false).'),
        limit: z.number().int().min(1).max(500).optional().describe('Journal entries to show, last N (default 50).')
      }
    },
    async ({ game_id, kind, clear, limit }) => {
      try {
        const session = manager.resolve(game_id);
        const want = kind ?? 'all';
        const parts: string[] = [];

        if (want === 'console' || want === 'all') {
          const body = renderConsole(session.console);
          if (want === 'all') parts.push(`Console (${session.console.length}):\n${body}`);
          else parts.push(body);
          if (clear) session.console = [];
        }

        if (want === 'journal' || want === 'all') {
          const entries = session.journal;
          if (!entries.length) {
            parts.push('Journal: empty (no actions taken yet).');
          } else {
            const shown = entries.slice(-(limit ?? 50));
            const visited = new Set(entries.map((e) => e.passage).filter(Boolean));
            const lines = shown.map((e) => `#${e.step} ${e.passage ?? '?'} — ${e.action}${e.target ? ` -> ${e.target}` : ''}`);
            const header = `Journal: ${entries.length} action(s), ${visited.size} distinct passage(s) visited. Showing last ${shown.length}.`;
            parts.push(header + '\n' + lines.join('\n'));
          }
          if (clear) session.journal = [];
        }

        return text(parts.join('\n\n'));
      } catch (err) {
        return fromError(manager, 'logs-failed', err);
      }
    }
  );

  register(
    'upload_file',
    {
      title: 'Upload a file into the game',
      description:
        'Upload a local file (mod .zip, .save, image) into an <input type=file>. Pass trigger to click the button that opens the picker, or file_input for the input itself. Searches all frames when neither is given.',
      inputSchema: {
        game_id: gameIdParam,
        file_path: z.string().describe('Absolute path of the file on the machine running this MCP server.'),
        trigger: z.string().optional().describe('Button that opens the picker: a ref from find_ui, a CSS selector, or visible text.'),
        file_input: z.string().optional().describe('The <input type=file> itself: a ref from find_ui, or a CSS selector.'),
        format: formatParam
      }
    },
    async ({ game_id, file_path, trigger, file_input, format }) => {
      try {
        const session = manager.resolve(game_id);
        // A ref is a bare token; anything else is treated as a CSS selector by the bridge.
        const isSelector = (s: string) => /[#.[\]:>+~\s]/.test(s);
        const res = await manager.uploadFile(session, {
          path: file_path,
          // The bridge resolves `trigger` as ref / selector / visible text.
          ...(file_input ? (isSelector(file_input) ? { selector: file_input } : { ref: file_input }) : {}),
          ...(trigger ? { trigger } : {})
        });
        if (!res.ok) {
          return errResult(res.error ?? 'upload-failed', res.message, {
            hint:
              res.error === 'no-file-input'
                ? 'Find the import button with find_ui("Load from File") / find_ui("Import") and pass its ref as trigger.'
                : 'Check the file path and the trigger.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Uploaded "${file_path}".`, action: { upload: file_path } });
      } catch (err) {
        return fromError(manager, 'upload-failed', err);
      }
    }
  );

  register(
    'download_file',
    {
      title: 'Browser downloads (list / save / newest)',
      description:
        'Every browser download is captured into a persistent folder. list: show it. save: copy a captured file (pass trigger to click the game\'s export button first). newest: take the newest capture.',
      inputSchema: {
        game_id: gameIdParam,
        action: z.enum(['list', 'save', 'newest']).describe('list the folder, save a captured file, or take the newest one.'),
        trigger: z.string().optional().describe('For action:"save": click this first — a ref, a CSS selector, or visible text.'),
        name: z.string().optional().describe('Captured file name (exact, suffix, or unique substring).'),
        index: z.number().int().min(1).max(200).optional().describe('1-based index from action:"list" (newest first).'),
        dest_file: z.string().optional().describe('Exact destination file path (written even if it exists).'),
        dest_dir: z.string().optional().describe('Destination directory; the captured file name is kept.'),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe('How long to wait for a download after clicking the trigger (default 30000).'),
        limit: z.number().int().min(1).max(200).optional().describe('For action:"list": max files (default 20).'),
        format: formatParam
      }
    },
    async ({ game_id, action, trigger, name, index, dest_file, dest_dir, timeout_ms, limit, format }) => {
      try {
        const session = action === 'list' ? undefined : manager.resolve(game_id);

        if (action === 'list') {
          const res = await manager.listDownloads(limit ?? 20);
          const fallbackNote = res.fellBack
            ? `\n(preferred folder unusable — ${res.fallbackReason ?? 'unknown reason'}; using this one instead)`
            : '';
          if (!res.files.length) {
            return text(`Download folder: ${res.dir}${fallbackNote}\n(empty — trigger a download first, e.g. the game's save/export button)`);
          }
          const lines = [
            `Download folder: ${res.dir} (${res.total} file${res.total === 1 ? '' : 's'}, newest first${res.total > res.files.length ? `, showing ${res.files.length}` : ''}):${fallbackNote}`
          ];
          res.files.forEach((f, i) => {
            const when = new Date(f.mtime).toISOString().replace('T', ' ').slice(0, 16);
            lines.push(`  ${i + 1}. ${f.name} — ${f.bytes} B — ${when}`);
          });
          lines.push('Use action:"save" with name/index to copy one anywhere.');
          return text(lines.join('\n'));
        }

        const dest = dest_file ?? dest_dir;
        const res = await manager.downloadFile(session!, {
          // The bridge resolves `trigger` as ref / selector / visible text.
          ...(trigger ? { target: trigger } : {}),
          name,
          index: action === 'newest' && !name && index === undefined ? 1 : index,
          path: dest,
          // A destination directory must be treated as one even before it exists.
          destIsDir: dest_dir !== undefined,
          timeoutMs: timeout_ms
        });
        if (!res.ok) {
          return errResult(res.error ?? 'download-failed', res.message, {
            hint:
              res.error === 'no-download'
                ? 'Run download_file(action:"list") to see captured files, or pass trigger to click the game\'s download button.'
                : 'Check the file name/index (action:"list") or the trigger.',
            passage: session?.lastObservation?.passage ?? null
          });
        }
        const prefix = `Saved "${res.filename ?? 'file'}" -> ${res.path} (${res.bytes ?? 0} B${res.copied ? ', copied' : ''}${res.overwrote ? ', overwrote existing file' : ''})`;
        if (!trigger) {
          // No game element was touched, so the passage cannot have changed.
          return text(`${prefix}\n(game state unchanged)`);
        }
        return observationResult(session!, res.observation!, {
          format,
          prefix,
          action: { path: res.path ?? null, source: res.source ?? null, filename: res.filename ?? null, bytes: res.bytes ?? 0, copied: !!res.copied }
        });
      } catch (err) {
        return fromError(manager, 'download-failed', err);
      }
    }
  );

  register(
    'screenshot',
    {
      title: 'Screenshot the game',
      description:
        'PNG of the game viewport — canvas games, visual QA. Pass path to save it to disk instead of returning the image. One-shot: use live_view to let the user watch.',
      inputSchema: {
        game_id: gameIdParam,
        path: z.string().optional().describe('Write the PNG here and return the path instead of the image.')
      }
    },
    async ({ game_id, path }) => {
      try {
        const session = manager.resolve(game_id);
        const buf = await manager.screenshot(session, path);
        if (path) return text(`Screenshot saved: ${path} (${buf.length} bytes)`);
        return { content: [{ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' }] };
      } catch (err) {
        return fromError(manager, 'screenshot-failed', err);
      }
    }
  );

  register(
    'live_view',
    {
      title: 'Show the game to the user',
      description:
        'Show the user the real page the agent drives: a local URL streaming JPEG frames (~1/s) plus passage, step, actions. Works headless. open:true launches the default browser. Repeat calls return the same URL.',
      inputSchema: {
        game_id: gameIdParam,
        open: z.boolean().optional().describe('Also open the URL in the default browser (at most once per game).')
      }
    },
    async ({ game_id, open }) => {
      try {
        const session = manager.resolve(game_id);
        const url = await liveViewUrl(manager, session);
        const headed = manager.browserIsHeaded;
        let openNote = '';
        if (open) {
          if (headed) {
            openNote =
              'Auto-open skipped: this game already runs in a visible (headed) browser window, so the user can already see the real page — do not add a second view. ';
          } else if (claimAutoOpen(session.id)) {
            openNote = openInBrowser(url)
              ? 'Opened in the default browser. '
              : 'Could not launch a browser (no xdg-open/open?) — open the URL manually. ';
          } else {
            openNote = 'A browser was already opened for this game earlier — reuse that tab; the URL is unchanged. ';
          }
        }
        const head = headed ? 'NOTE: headed (visible) browser window in use — one view is enough; do not open another.\n' : '';
        // The URL is stable, so only the first call needs the explanation.
        if (!claimFirstReport(session.id)) {
          return text(`${head}Live view for ${session.id}: ${url}${openNote ? `\n${openNote.trim()}` : ''}`);
        }
        return text(
          head +
            `Live view for ${session.id}: ${url}\n` +
            openNote +
            'Refreshes ~1/s and shows passage/step/journal. Display policy: one view per game — reuse an open view instead of stacking another.'
        );
      } catch (err) {
        return fromError(manager, 'live-view-failed', err);
      }
    }
  );

  register(
    'session',
    {
      title: 'Manage game sessions',
      description: 'list: the open games (id, title, format, step, source). close: shut one down, including its browser context and static server.',
      inputSchema: {
        action: z.enum(['list', 'close']).describe('list open games, or close one.'),
        game_id: gameIdParam
      }
    },
    async ({ action, game_id }) => {
      if (action === 'list') {
        const games = manager.listSessions();
        if (!games.length) return text('No open games.');
        return text(
          games.map((g) => `${g.id} · ${g.title} · ${g.format} · step ${g.step} · ${g.source}`).join('\n')
        );
      }
      try {
        const session = manager.resolve(game_id);
        const ok = await manager.close(session.id);
        if (ok) forgetLiveView(session.id);
        return text(ok ? `Closed ${session.id}.` : `No such game: ${session.id}.`, !ok);
      } catch (err) {
        return fromError(manager, 'close-failed', err);
      }
    }
  );

  return server;
}
