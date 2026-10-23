import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { REMOTE_TOOLS } from './remote-profile.js';

export type AcceptanceReport = {
  status: 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL';
  checks: string[];
  failedStage?: string;
  timestamp?: string;
};
/** Runs through the PUBLIC HTTPS origin using the official MCP client. Never logs credentials,
 * game ids, or raw SDK errors (errors can contain request URLs). No browser/network bypasses. */
export async function runPublicAcceptance(origin: string, secret: string, report: AcceptanceReport) {
  const sessions: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
  let stage = 'public HTTPS URL';
  const ensure = (condition: unknown) => {
    if (!condition) throw new Error('Check failed');
  };
  const pass = (name: string) => {
    report.checks.push(name);
    console.error(`[public acceptance] ${name} PASS`);
  };
  const connect = async () => {
    const client = new Client({ name: 'twine-public-acceptance', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`/${secret}/mcp`, origin));
    sessions.push({ client, transport });
    await client.connect(transport);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    stage = name;
    const result = await client.callTool({ name, arguments: args });
    ensure(!result.isError);
    return result;
  };
  const text = (result: any) =>
    result.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
  const json = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(text(await call(client, name, { ...args, format: 'json' })));
  report.status = 'RUNNING';
  try {
    ensure(new URL(origin).protocol === 'https:');
    stage = 'initialize';
    const a = await connect();
    pass('initialize');
    stage = 'tools/list';
    const listed = (await a.listTools()).tools;
    ensure(JSON.stringify(listed.map((t) => t.name).sort()) === JSON.stringify([...REMOTE_TOOLS].sort()));
    for (const tool of listed) {
      ensure(tool.description && tool.inputSchema);
      ensure(
        tool.annotations?.readOnlyHint === ['observe', 'find_ui', 'get_variables', 'screenshot'].includes(tool.name),
      );
      ensure(tool.annotations?.openWorldHint === (tool.name === 'open_game'));
      ensure(tool.annotations?.destructiveHint === ['navigate', 'snapshot', 'session'].includes(tool.name));
    }
    pass('tools/list');
    pass('annotations');
    for (const format of ['sugarcube', 'harlowe', 'snowman', 'chapbook']) {
      const first = await json(a, 'open_game', { source: new URL(`/fixtures/${format}.html`, origin).href });
      ensure(first.format === format && first.text && first.choices.length >= 2);
      pass(`${format}:open_game`);
      ensure((await json(a, 'observe')).text === first.text);
      pass(`${format}:observe`);
      const next = await json(a, 'choose', { choice: 1 });
      ensure(next.text !== first.text && next.step > first.step);
      pass(`${format}:choose`);
      const shot = await call(a, 'screenshot');
      const img: any = (shot.content as any[]).find((c: any) => c.type === 'image');
      ensure(img?.mimeType === 'image/png');
      const data = Buffer.from(img.data, 'base64');
      ensure(
        data.subarray(1, 4).toString() === 'PNG' && data.readUInt32BE(16) === 1280 && data.readUInt32BE(20) === 800,
      );
      pass(`${format}:screenshot`);
      if (format === 'sugarcube') {
        await call(a, 'navigate', { action: 'back' });
        pass('navigate:back');
        const vars = text(await call(a, 'get_variables', { paths: ['coins'] }));
        pass('get_variables');
        await call(a, 'snapshot', { action: 'save', name: 'branch' });
        const branchA = await json(a, 'choose', { choice: 1 });
        await call(a, 'snapshot', { action: 'load', name: 'branch' });
        const branchB = await json(a, 'choose', { choice: 2 });
        ensure(branchA.text !== branchB.text);
        ensure(text(await call(a, 'get_variables', { paths: ['coins'] })) !== vars);
        await call(a, 'snapshot', { action: 'load', name: 'branch' });
        ensure(text(await call(a, 'get_variables', { paths: ['coins'] })) === vars);
        pass('snapshot:branches-and-variables');
        let previous = await json(a, 'observe');
        for (let i = 0; i < 10; i++) {
          const choice = i % 2 === 0 ? 'Open the door' : 'Back';
          ensure(previous.choices.some((c: any) => c.label === choice));
          const current = await json(a, 'choose', { choice });
          ensure(current.step > previous.step && current.text !== previous.text);
          ensure((await json(a, 'observe')).text === current.text);
          previous = current;
        }
        pass('10-step-continuous-play');
      }
      await call(a, 'session', { action: 'close' });
    }
    stage = 'session isolation';
    const b = await connect();
    const gameA = await json(a, 'open_game', { source: new URL('/fixtures/sugarcube.html', origin).href });
    const gameB = await json(b, 'open_game', { source: new URL('/fixtures/sugarcube.html', origin).href });
    await call(a, 'choose', { choice: 1 });
    ensure((await json(b, 'observe')).text === gameB.text);
    ensure((await b.callTool({ name: 'observe', arguments: { game_id: gameA.game_id } })).isError);
    pass('session-isolation');
    stage = 'file and private URL rejection';
    for (const source of [
      '/etc/passwd',
      'file:///etc/passwd',
      'http://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
    ]) {
      ensure((await a.callTool({ name: 'open_game', arguments: { source } })).isError);
    }
    pass('negative-inputs');
    report.status = 'PASS';
  } catch {
    report.status = 'FAIL';
    report.failedStage = stage;
    console.error(`[public acceptance] FAIL at ${stage}; credential-bearing errors omitted`);
  } finally {
    for (const { client, transport } of sessions) {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
    report.timestamp = new Date().toISOString();
  }
}
