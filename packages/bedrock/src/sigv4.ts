import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 escaping, as SigV4 wants it: everything but unreserved characters. */
const escape = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `20261019T120000Z` */
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Signature Version 4 headers for one request. The path is escaped once more
 * than it is sent, as every service but S3 expects, so a model id's `:` (sent
 * as `%3A`) is signed as `%253A`.
 */
export function sign(
  request: { method: string; url: string; headers?: Record<string, string>; body?: string },
  credentials: AwsCredentials,
  scope: { region: string; service: string },
  now = new Date()
): Record<string, string> {
  const url = new URL(request.url);
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: url.host, "x-amz-date": stamp };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const lower = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const);
  lower.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = lower.map(([name]) => name).join(";");
  const path = url.pathname.split("/").map((segment) => escape(segment)).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [escape(k), escape(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [request.method, path, query, lower.map(([n, v]) => `${n}:${v}\n`).join(""), signed, sha256(request.body ?? "")].join("\n");
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, credentialScope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), scope.region), scope.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const out: Record<string, string> = { ...request.headers, "x-amz-date": stamp };
  if (credentials.sessionToken) out["x-amz-security-token"] = credentials.sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signed}, Signature=${signature}`;
  return out;
}
