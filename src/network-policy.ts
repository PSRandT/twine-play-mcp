import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';

/** Only globally routable addresses. IPv4-mapped IPv6 is normalized before testing. */
export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv6') {
      const v6 = ip as ipaddr.IPv6;
      // Global unicast only; exclude transition/translation/documentation/special-use space.
      return (
        v6.match(ipaddr.IPv6.parse('2000::'), 3) &&
        !v6.match(ipaddr.IPv6.parse('2001::'), 23) &&
        !v6.match(ipaddr.IPv6.parse('2001:db8::'), 32) &&
        !v6.match(ipaddr.IPv6.parse('2002::'), 16) &&
        !v6.match(ipaddr.IPv6.parse('3fff::'), 20)
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function publicHttpsUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Remote games require a public HTTPS URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    source.length > 4096 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    (!host.includes('.') && !host.includes(':')) ||
    /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host.replace(/\.$/, '')) ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  ) {
    throw new Error('Only public HTTPS games on port 443 are allowed.');
  }
  return url;
}

export async function resolvePublic(
  host: string,
  resolver: (host: string) => Promise<Array<{ address: string }>> = (host) =>
    lookup(host, { all: true, verbatim: true }),
): Promise<string[]> {
  const records = await resolver(host);
  if (!records.length || records.some((r) => !isPublicAddress(r.address))) {
    throw new Error('Private or special-use network destination blocked.');
  }
  return records.map((r) => r.address);
}
