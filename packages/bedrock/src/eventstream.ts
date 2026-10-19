/** One message of AWS's binary event stream (`application/vnd.amazon.eventstream`). */
export interface StreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/** A header's value: strings are what Bedrock sends; the other types are skipped by their width. */
function readHeaders(view: DataView, bytes: Uint8Array, start: number, end: number): Record<string, string> {
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  let at = start;
  while (at < end) {
    const nameLength = view.getUint8(at);
    const name = decoder.decode(bytes.subarray(at + 1, at + 1 + nameLength));
    at += 1 + nameLength;
    const type = view.getUint8(at);
    at += 1;
    if (type === 7 || type === 6) {
      const length = view.getUint16(at);
      if (type === 7) out[name] = decoder.decode(bytes.subarray(at + 2, at + 2 + length));
      at += 2 + length;
    } else at += [0, 0, 1, 2, 4, 8, -1, -1, 8, 16][type] ?? Number.POSITIVE_INFINITY;
  }
  return out;
}

/**
 * The messages of an event stream as they arrive. Each is framed by its total
 * length and the length of its headers; the CRCs are left to TLS.
 */
export async function* eventStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamMessage> {
  let buffer = new Uint8Array(0);
  for await (const chunk of body) {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    while (buffer.length >= 12) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const total = view.getUint32(0);
      if (total < 16) throw new Error(`Malformed event stream message of ${total} bytes`);
      if (buffer.length < total) break;
      const headerLength = view.getUint32(4);
      const headers = readHeaders(view, buffer, 12, 12 + headerLength);
      yield { headers, payload: buffer.slice(12 + headerLength, total - 4) };
      buffer = buffer.slice(total);
    }
  }
}
