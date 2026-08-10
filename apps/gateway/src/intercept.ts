import { request } from "undici";
import type { UpstreamResponse } from "./app.js";

/**
 * The real forwarder to the provider. Kept out of app.ts so tests can inject a
 * fake upstream and run without network access.
 */
export async function forwardUpstream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  streaming: boolean,
  method = "POST",
): Promise<UpstreamResponse> {
  const res = await request(url, {
    method: method as "GET" | "POST",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // why: streams can idle for a long time between tokens — don't cut them off.
    headersTimeout: streaming ? 120_000 : 60_000,
    bodyTimeout: streaming ? 0 : 120_000,
  });

  if (streaming) {
    return { status: res.statusCode, headers: res.headers, stream: res.body };
  }
  const text = await res.body.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: { message: text.slice(0, 500), type: "upstream_non_json" } };
  }
  return { status: res.statusCode, headers: res.headers, json };
}
