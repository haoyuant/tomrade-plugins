import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, header } from "../src/proto.js";

describe("frames", () => {
  it("round-trips every field, keeping 64-bit ids exact", () => {
    const frame = { SeqID: 18446744073709551615n, LogID: 9007199254740993n, service: 33, method: 1,
      headers: [{ key: "type", value: "event" }, { key: "trace_id", value: "追踪" }], payloadEncoding: "json", payloadType: "event",
      payload: new TextEncoder().encode('{"a":1}'), LogIDNew: "x" };
    const back = decodeFrame(encodeFrame(frame));
    expect(back).toEqual(frame);
    expect(header(back, "trace_id")).toBe("追踪");
  });

  it("reads a negative int32 written as ten bytes", () => {
    expect(decodeFrame(encodeFrame({ SeqID: 0n, LogID: 0n, service: -1, method: 0, headers: [] })).service).toBe(-1);
  });

  it("skips fields it does not know", () => {
    const known = encodeFrame({ SeqID: 1n, LogID: 2n, service: 3, method: 0, headers: [] });
    const extra = Uint8Array.from([...known, (14 << 3) | 0, 5, (15 << 3) | 2, 2, 7, 7]);
    expect(decodeFrame(extra).service).toBe(3);
  });

  it("refuses a truncated frame", () => {
    const bytes = encodeFrame({ SeqID: 1n, LogID: 2n, service: 3, method: 1, headers: [], payload: new Uint8Array(10) });
    expect(() => decodeFrame(bytes.slice(0, bytes.length - 3))).toThrow();
  });
});
