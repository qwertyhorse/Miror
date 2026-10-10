import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "./types.ts";

const fakeAddress = (address: string) =>
  isIP(address) === 4 && /^198\.(18|19)\./.test(address);
const unavailable = () =>
  new ApiError("MEDIA_DNS_UNAVAILABLE", "素材地址解析失败，请重试。", 502);
type DnsType = "A" | "AAAA";

/** Clash fake IPs describe local routing, not the remote server. Verify the
 * requested hostname with a public HTTPS resolver without accepting fake IPs. */
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
  if (!addresses.every(fakeAddress)) return addresses;
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
        !("data" in row) ||
        (row.type !== 1 && row.type !== 28) ||
        typeof row.data !== "string" ||
        !isIP(row.data)
      )
        return [];
      return [row.data];
    });
  };
  const resolved = (results: PromiseSettledResult<string[]>[]) => {
    const values = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (values.some(fakeAddress)) throw unavailable();
    return [...new Set(values)];
  };
  const primary = await Promise.allSettled(
    types.map((type) => query("https://cloudflare-dns.com/dns-query", type)),
  );
  const primaryAddresses = resolved(primary);
  if (primaryAddresses.length) return primaryAddresses;
  const failedTypes = types.filter(
    (_, index) => primary[index].status === "rejected",
  );
  if (failedTypes.length) {
    // Google documents this JSON DoH endpoint with the same name/type fields.
    const fallback = await Promise.allSettled(
      failedTypes.map((type) => query("https://dns.google/resolve", type)),
    );
    const fallbackAddresses = resolved(fallback);
    if (fallbackAddresses.length) return fallbackAddresses;
  }
  throw unavailable();
}
