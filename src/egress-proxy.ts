import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { resolvePublic, publicHttpsUrl, isPublicAddress } from './network-policy.js';

/** A CONNECT-only, loopback proxy. DNS is validated once and the socket uses that exact IP.
 * Chrome retains end-to-end TLS hostname/certificate verification. No hostname re-resolution.
 * Dependencies are injectable ONLY by code in tests, never through environment/config/requests.
 */
export async function createEgressProxy(
  deps: {
    resolve?: typeof resolvePublic;
    connect?: (ip: string) => net.Socket;
  } = {},
) {
  const resolve = deps.resolve ?? resolvePublic;
  const connect = deps.connect ?? ((ip: string) => net.connect({ host: ip, port: 443 }));
  const sockets = new Set<Duplex>();
  let active = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(45_000, () => socket.destroy());
  });
  server.on('connect', (req, client, head) => {
    if (++active > 64) {
      active--;
      client.destroy();
      return;
    }
    let upstream: net.Socket | undefined;
    const stop = () => {
      client.destroy();
      upstream?.destroy();
    };
    const timer = setTimeout(stop, 45_000);
    timer.unref();
    client.once('close', () => {
      active--;
      clearTimeout(timer);
      upstream?.destroy();
    });
    client.on('error', stop);
    void (async () => {
      try {
        if (!req.url || /[\/?#@]/.test(req.url) || !req.url.endsWith(':443')) throw new Error('Invalid CONNECT');
        const url = publicHttpsUrl(`https://${req.url}`);
        const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ''));
        if (!addresses.length || addresses.some((ip) => !isPublicAddress(ip))) throw new Error('Destination blocked');
        if (client.destroyed) return;
        upstream = connect(addresses.find((ip) => net.isIP(ip) === 4) ?? addresses[0]!);
        sockets.add(upstream);
        upstream.on('close', () => {
          sockets.delete(upstream!);
          client.destroy();
        });
        upstream.on('error', stop);
        upstream.setTimeout(20_000, stop);
        let bytes = 0;
        const count = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) stop();
        };
        upstream.on('data', count);
        client.on('data', count);
        upstream.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream!.write(head);
          client.pipe(upstream!);
          upstream!.pipe(client);
        });
      } catch {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    })();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
