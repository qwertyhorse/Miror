import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "./types.ts";

/** Benchmark ranges also used as local proxy placeholders, never public media hosts. */
export function isBenchmarkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return /^198\.(18|19)\./.test(address);
  if (family !== 6) return false;
  // Expand before checking the /48 prefix, including leading zeroes and a
  // dotted IPv4 suffix (which occupies two hextets).
  const literal = address.split('%')[0].replace(/\d+\.\d+\.\d+\.\d+$/, '0:0');
  const [head, tail] = literal.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = tail === undefined ? leading : [
    ...leading, ...Array(8 - leading.length - trailing.length).fill('0'), ...trailing,
  ];
  return Number.parseInt(groups[0], 16) === 0x2001
    && Number.parseInt(groups[1], 16) === 2
    && Number.parseInt(groups[2], 16) === 0;
}
const unavailable = () =>
  new ApiError("MEDIA_DNS_UNAVAILABLE", "素材地址解析失败，请重试。", 502);
type DnsType = "A" | "AAAA";

/** Proxy placeholder IPs describe local routing, not the remote server. Verify
 * both address families with public HTTPS DNS while retaining other local IPs. */
export async function resolveMediaHost(
  host: string,
  options: {
    local?: (host: string) => Promise<string[]>;
    fetcher?: typeof fetch;
  } = {},
): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = await (options.local
      ? options.local(host)
      : lookup(host, { all: true }).then((rows) =>
          rows.map((row) => row.address),
        ));
  } catch {
    throw unavailable();
  }
  if (!addresses.length) throw unavailable();
  if (!addresses.some(isBenchmarkAddress)) return addresses;
  const localAddresses = addresses.filter(address => !isBenchmarkAddress(address));
  const fetcher = options.fetcher ?? fetch;
  const types: DnsType[] = ["A", "AAAA"];
  const query = async (endpoint: string, type: DnsType) => {
    const query = new URL(endpoint);
    query.searchParams.set("name", host);
    query.searchParams.set("type", type);
    const response = await fetcher(query, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Public DNS lookup unavailable");
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("Status" in value) ||
      value.Status !== 0
    )
      throw new Error("Public DNS lookup failed");
    const answer = "Answer" in value ? value.Answer : [];
    if (!Array.isArray(answer)) throw new Error("Invalid public DNS answer");
    // Preserve every explicit IP answer, including a blocked address from the
    // other family, so a successful public answer cannot hide it from callers.
    return answer.flatMap((row: unknown): string[] => {
      if (
        !row ||
        typeof row !== "object" ||
        !("type" in row) ||
        (row.type !== 1 && row.type !== 28)
      )
        return [];
      if (!('data' in row) || typeof row.data !== 'string' || !isIP(row.data))
        throw new Error('Invalid public DNS address');
      return [row.data];
    });
  };
  const primary = await Promise.allSettled(
    types.map((type) => query("https://cloudflare-dns.com/dns-query", type)),
  );
  // A successful A response must not hide an unresolved AAAA response, or vice
  // versa. Retry each failed family, then fail closed if either remains unknown.
  const verified = await Promise.allSettled(
    primary.map((result, index) => result.status === 'fulfilled'
      ? Promise.resolve(result.value)
      : query('https://dns.google/resolve', types[index])),
  );
  if (verified.some(result => result.status === 'rejected')) throw unavailable();
  const remoteAddresses = verified.flatMap(result =>
    result.status === 'fulfilled' ? result.value : []);
  if (!remoteAddresses.length || remoteAddresses.some(isBenchmarkAddress)) throw unavailable();
  // Do not discard a real private/local address alongside proxy placeholders:
  // the caller must still reject the complete set when any address is blocked.
  return [...new Set([...localAddresses, ...remoteAddresses])];
}
