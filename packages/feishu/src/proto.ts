/**
 * The long connection's frame (pbbp2.Frame), encoded by hand: nine fields,
 * so a protobuf library would be most of the bundle. SeqID and LogID stay
 * bigints because an acknowledgement echoes them back exactly.
 */
export interface Frame {
  SeqID: bigint;
  LogID: bigint;
  service: number;
  method: number;
  headers: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
}

export const FrameMethod = { control: 0, data: 1 } as const;

const utf8 = new TextEncoder();
const text = new TextDecoder();

class Writer {
  private bytes: number[] = [];
  varint(value: bigint) {
    let v = BigInt.asUintN(64, value);
    while (v > 0x7fn) { this.bytes.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
    this.bytes.push(Number(v));
  }
  tag(field: number, wire: number) { this.varint(BigInt((field << 3) | wire)); }
  raw(field: number, data: Uint8Array) {
    this.tag(field, 2);
    this.varint(BigInt(data.length));
    for (const b of data) this.bytes.push(b);
  }
  string(field: number, value: string) { this.raw(field, utf8.encode(value)); }
  finish(): Uint8Array<ArrayBuffer> { return Uint8Array.from(this.bytes); }
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done() { return this.pos >= this.buf.length; }
  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
    }
    throw new Error("varint too long");
  }
  bytes(): Uint8Array {
    const n = Number(this.varint());
    if (this.pos + n > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

const int32 = (v: bigint) => Number(BigInt.asIntN(32, v));

export function encodeFrame(f: Frame): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  w.tag(1, 0); w.varint(f.SeqID);
  w.tag(2, 0); w.varint(f.LogID);
  w.tag(3, 0); w.varint(BigInt(f.service));
  w.tag(4, 0); w.varint(BigInt(f.method));
  for (const h of f.headers) {
    const hw = new Writer();
    hw.string(1, h.key);
    hw.string(2, h.value);
    w.raw(5, hw.finish());
  }
  if (f.payloadEncoding !== undefined) w.string(6, f.payloadEncoding);
  if (f.payloadType !== undefined) w.string(7, f.payloadType);
  if (f.payload !== undefined) w.raw(8, f.payload);
  if (f.LogIDNew !== undefined) w.string(9, f.LogIDNew);
  return w.finish();
}

export function decodeFrame(buf: Uint8Array): Frame {
  const r = new Reader(buf);
  const f: Frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  while (!r.done) {
    const tag = Number(r.varint());
    const field = tag >> 3, wire = tag & 7;
    switch (field) {
      case 1: f.SeqID = r.varint(); break;
      case 2: f.LogID = r.varint(); break;
      case 3: f.service = int32(r.varint()); break;
      case 4: f.method = int32(r.varint()); break;
      case 5: {
        const hr = new Reader(r.bytes());
        const h = { key: "", value: "" };
        while (!hr.done) {
          const ht = Number(hr.varint());
          if (ht >> 3 === 1) h.key = text.decode(hr.bytes());
          else if (ht >> 3 === 2) h.value = text.decode(hr.bytes());
          else hr.skip(ht & 7);
        }
        f.headers.push(h);
        break;
      }
      case 6: f.payloadEncoding = text.decode(r.bytes()); break;
      case 7: f.payloadType = text.decode(r.bytes()); break;
      case 8: f.payload = r.bytes().slice(); break;
      case 9: f.LogIDNew = text.decode(r.bytes()); break;
      default: r.skip(wire);
    }
  }
  return f;
}

export const header = (f: Frame, key: string) => f.headers.find(h => h.key === key)?.value;
