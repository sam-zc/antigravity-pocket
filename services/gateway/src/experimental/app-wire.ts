import { ProbeError } from './app-probe.js';

/** App 2.29.0 protobuf wire reader. Length-delimited fields are views, never recursively decoded by default. */
export function varint(
  bytes: Buffer,
  start: number,
): { value: number; end: number } | undefined {
  let value = 0,
    scale = 1;
  for (let i = start; i < start + 8; i++) {
    if (i >= bytes.length) return;
    const byte = bytes[i]!;
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) throw new ProbeError('malformed_wire');
    if (byte < 128) return { value, end: i + 1 };
    scale *= 128;
  }
  throw new ProbeError('malformed_wire');
}
export function encodeVarint(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ProbeError('malformed_wire');
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next + (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
export function selectedFields(
  bytes: Buffer,
  selected: readonly number[],
  signed: readonly number[] = [],
) {
  const result = new Map<number, (number | Buffer)[]>();
  let offset = 0,
    fields = 0;
  while (offset < bytes.length) {
    if (++fields > 4096) throw new ProbeError('wire_field_limit');
    const tag = varint(bytes, offset);
    if (!tag || tag.value < 8) throw new ProbeError('malformed_wire');
    offset = tag.end;
    const field = Math.floor(tag.value / 8),
      wire = tag.value % 8;
    let value: number | Buffer | undefined;
    if (wire === 0) {
      if (selected.includes(field)) {
        if (signed.includes(field)) {
          let number = 0n,
            shift = 0n,
            count = 0;
          while (true) {
            const next = bytes[offset++];
            if (
              next === undefined ||
              ++count > 10 ||
              (count === 10 && next > 1)
            )
              throw new ProbeError('malformed_wire');
            number |= BigInt(next & 127) << shift;
            shift += 7n;
            if (next < 128) break;
          }
          if (number > 2147483647n && number < 18446744071562067968n)
            throw new ProbeError('malformed_wire');
          value = Number(BigInt.asIntN(32, number));
        } else {
          const next = varint(bytes, offset);
          if (!next) throw new ProbeError('malformed_wire');
          value = next.value;
          offset = next.end;
        }
      } else {
        let count = 0;
        while (true) {
          const next = bytes[offset++];
          if (next === undefined || ++count > 10 || (count === 10 && next > 1))
            throw new ProbeError('malformed_wire');
          if (next < 128) break;
        }
      }
    } else if (wire === 2) {
      const size = varint(bytes, offset);
      if (!size || size.value > bytes.length - size.end)
        throw new ProbeError('malformed_wire');
      value = bytes.subarray(size.end, size.end + size.value);
      offset = size.end + size.value;
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new ProbeError('malformed_wire');
    if (offset > bytes.length) throw new ProbeError('malformed_wire');
    if (selected.includes(field)) {
      if (value === undefined) throw new ProbeError('malformed_wire');
      const list = result.get(field) ?? [];
      list.push(value);
      result.set(field, list);
    }
  }
  return result;
}
export function single(fields: Map<number, (number | Buffer)[]>, key: number) {
  const values = fields.get(key);
  if (values && values.length !== 1) throw new ProbeError('ambiguous_wire');
  return values?.[0];
}
export function bytes(value: number | Buffer | undefined): Buffer {
  if (!Buffer.isBuffer(value)) throw new ProbeError('malformed_wire');
  return value;
}
export function integer(value: number | Buffer | undefined, fallback = 0) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || value > 2147483647)
    throw new ProbeError('malformed_wire');
  return value;
}
export function string(value: number | Buffer | undefined, max: number) {
  const input = bytes(value);
  if (input.length > max) throw new ProbeError('content_limit');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new ProbeError('unsafe_content');
  }
}

/** Incremental outer StepsResponse parser. At most one 256 KiB step plus one transport chunk is buffered. */
export class StepWindowParser<T> {
  private buffer = Buffer.alloc(262144 + 65536 + 16);
  private used = 0;
  readonly rows: T[] = [];
  peakBuffered = 0;
  constructor(
    private decode: (step: Buffer, index: number) => T,
    private maxRows = 20,
  ) {
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 20)
      throw new ProbeError('invalid_window');
  }
  push(chunk: Buffer) {
    if (this.rows.length === this.maxRows) return true;
    if (chunk.length > 65536) throw new ProbeError('chunk_limit');
    if (this.used + chunk.length > this.buffer.length)
      throw new ProbeError('step_limit');
    chunk.copy(this.buffer, this.used);
    this.used += chunk.length;
    this.peakBuffered = Math.max(this.peakBuffered, this.used);
    const pending = this.buffer.subarray(0, this.used);
    let consumed = 0;
    while (consumed < this.used) {
      const tag = varint(pending, consumed);
      if (!tag) break;
      if (tag.value !== 10) throw new ProbeError('incompatible_response');
      const length = varint(pending, tag.end);
      if (!length) break;
      if (length.value > 262144) throw new ProbeError('step_limit');
      const end = length.end + length.value;
      if (this.used < end) break;
      this.rows.push(
        this.decode(pending.subarray(length.end, end), this.rows.length),
      );
      consumed = end;
      if (this.rows.length === this.maxRows) {
        this.buffer.fill(0);
        this.used = 0;
        return true;
      }
    }
    if (consumed) {
      this.buffer.copyWithin(0, consumed, this.used);
      this.used -= consumed;
      this.buffer.fill(0, this.used);
    }
    return false;
  }
  finish() {
    if (this.used) throw new ProbeError('truncated_wire');
    this.buffer.fill(0);
  }
}
