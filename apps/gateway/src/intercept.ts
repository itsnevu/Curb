import { request } from "undici";
import type { UpstreamResponse } from "./app.js";

/**
 * Forwarder nyata ke provider. Dipisah dari app.ts supaya test bisa
 * menyuntik upstream palsu tanpa jaringan.
 */
export async function forwardUpstream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  streaming: boolean,
): Promise<UpstreamResponse> {
  const res = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    // why: streaming bisa lama menganggur di antara token — jangan putus.
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
