const RECORD_HEADER = 5;

const HANDSHAKE_RECORD = 0x16;

const CLIENT_HELLO = 0x01;

const SERVER_NAME_EXTENSION = 0x0000;

const HOST_NAME_TYPE = 0x00;

const MAX_RECORD = 16_384;

const RANDOM_LENGTH = 32;

class Reader {
  readonly buffer: Buffer;
  offset: number;
  readonly end: number;

  constructor(buffer: Buffer, offset: number, end: number) {
    this.buffer = buffer;
    this.offset = offset;
    this.end = Math.min(end, buffer.length);
  }

  has(length: number) {
    return this.offset + length <= this.end;
  }

  skip(length: number) {
    if (!this.has(length)) {
      return false;
    }

    this.offset += length;

    return true;
  }

  number(bytes: 1 | 2 | 3) {
    if (!this.has(bytes)) {
      return undefined;
    }

    const value = this.buffer.readUIntBE(this.offset, bytes);

    this.offset += bytes;

    return value;
  }

  vector(lengthBytes: 1 | 2) {
    const length = this.number(lengthBytes);

    if (length === undefined || !this.has(length)) {
      return undefined;
    }

    const vector = new Reader(this.buffer, this.offset, this.offset + length);

    this.offset += length;

    return vector;
  }
}

const MAX_HELLO_BYTES = RECORD_HEADER + MAX_RECORD;

const recordLength = (buffer: Buffer) =>
  buffer.length < RECORD_HEADER ? undefined : RECORD_HEADER + Math.min(buffer.readUInt16BE(3), MAX_RECORD);

export const isHelloComplete = (buffer: Buffer) => {
  if (buffer.length === 0) {
    return false;
  }

  const length = recordLength(buffer);

  return (
    buffer[0] !== HANDSHAKE_RECORD ||
    buffer.length >= MAX_HELLO_BYTES ||
    (length !== undefined && buffer.length >= length)
  );
};

const hostName = (list: Reader): string | undefined => {
  const type = list.number(1);
  const name = list.vector(2);

  if (type === undefined || name === undefined) {
    return undefined;
  }

  if (type !== HOST_NAME_TYPE) {
    return hostName(list);
  }

  return name.buffer.toString("ascii", name.offset, name.end);
};

const serverNameExtension = (extensions: Reader): string | undefined => {
  const type = extensions.number(2);
  const data = extensions.vector(2);

  if (type === undefined || data === undefined) {
    return undefined;
  }

  if (type !== SERVER_NAME_EXTENSION) {
    return serverNameExtension(extensions);
  }

  const list = data.vector(2);

  return list === undefined ? undefined : hostName(list);
};

const skipVector = (reader: Reader, lengthBytes: 1 | 2) => reader.vector(lengthBytes) !== undefined;

export const parseServerName = (buffer: Buffer): string | undefined => {
  if (buffer.length < RECORD_HEADER || buffer[0] !== HANDSHAKE_RECORD) {
    return undefined;
  }

  const record = new Reader(buffer, RECORD_HEADER, RECORD_HEADER + buffer.readUInt16BE(3));

  if (record.number(1) !== CLIENT_HELLO) {
    return undefined;
  }

  const helloLength = record.number(3);

  if (helloLength === undefined) {
    return undefined;
  }

  const hello = new Reader(buffer, record.offset, record.offset + helloLength);
  const headerRead =
    hello.skip(2 + RANDOM_LENGTH) && skipVector(hello, 1) && skipVector(hello, 2) && skipVector(hello, 1);

  if (!headerRead) {
    return undefined;
  }

  const extensions = hello.vector(2);
  const name = extensions === undefined ? undefined : serverNameExtension(extensions);

  return name === undefined || name.length === 0 ? undefined : name;
};
