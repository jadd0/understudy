// A small zip reader over positioned file reads: the end-of-central-directory record, the central
// directory, then one entry's local header and data on demand. It exists so an Instagram data
// download can be read without a dependency and without ever unpacking the whole archive.
//
// It reads only what it can bound. Zip64, multi-disk and encrypted archives, compression other than
// stored and deflate, an entry past `maxBytes`, a bad CRC and names that climb out of the archive
// are refused with a message that says what to do.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";

/** The largest single entry the reader will inflate. */
export const EXPORT_ENTRY_MAX_BYTES = 268_435_456;

// The comment field is at most 65,535 bytes, after the 22-byte fixed part.
const EOCD_SEARCH = 65_557;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_MAX_BYTES = 64 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

const ZIP64_MESSAGE = "this zip uses zip64 (a very large or many-part download): unzip it and pass the folder instead";

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw new ZipError("the zip ends early: the download is incomplete or damaged");
    done += n;
  }
  return buffer;
}

function unsafeName(name) {
  return name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..");
}

/**
 * @param {string} path
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ names: string[], read: (name: string) => Buffer, close: () => void }}
 */
export function openZip(path, { maxBytes = EXPORT_ENTRY_MAX_BYTES } = {}) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new ZipError("not a zip file");
    const tailLength = Math.min(size, EOCD_SEARCH);
    const tailStart = size - tailLength;
    const tail = readAt(fd, tailLength, tailStart);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new ZipError("not a zip file");
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw new ZipError(ZIP64_MESSAGE);

    const diskNumber = tail.readUInt16LE(eocd + 4);
    const directoryDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError(ZIP64_MESSAGE);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ZipError("this zip is split across several disks: merge the parts, unzip, and pass the folder instead");
    }
    if (directorySize > CENTRAL_DIRECTORY_MAX_BYTES || directoryOffset + directorySize > size) {
      throw new ZipError("the zip's directory is damaged");
    }

    const directory = readAt(fd, directorySize, directoryOffset);
    const entries = new Map();
    let at = 0;
    for (let n = 0; n < entryCount; n++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIG) throw new ZipError("the zip's directory is damaged");
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const compressedSize = directory.readUInt32LE(at + 20);
      const uncompressedSize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const localOffset = directory.readUInt32LE(at + 42);
      if (at + 46 + nameLength > directory.length) throw new ZipError("the zip's directory is damaged");
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError(ZIP64_MESSAGE);
      if (unsafeName(name)) throw new ZipError(`refusing an entry whose name leaves the archive: ${JSON.stringify(name)}`);
      if (name.endsWith("/")) continue;
      if (entries.has(name)) throw new ZipError(`the zip lists ${JSON.stringify(name)} twice`);
      entries.set(name, { flags, method, crc, compressedSize, uncompressedSize, localOffset });
    }

    return {
      names: [...entries.keys()],
      read(name) {
        const entry = entries.get(name);
        if (!entry) throw new ZipError(`no entry named ${JSON.stringify(name)}`);
        if (entry.flags & 1) throw new ZipError(`${JSON.stringify(name)} is encrypted: export again without a password or unzip it first`);
        if (entry.method !== 0 && entry.method !== 8) {
          throw new ZipError(`${JSON.stringify(name)} uses compression method ${entry.method}, which is not supported: unzip it and pass the folder`);
        }
        if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
          throw new ZipError(`${JSON.stringify(name)} is larger than the ${maxBytes}-byte limit`);
        }
        if (entry.localOffset + 30 > size) throw new ZipError("the zip's directory is damaged");
        const local = readAt(fd, 30, entry.localOffset);
        if (local.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`${JSON.stringify(name)} has a damaged header`);
        const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataStart + entry.compressedSize > size) throw new ZipError(`${JSON.stringify(name)} runs past the end of the zip`);
        const stored = readAt(fd, entry.compressedSize, dataStart);
        let data;
        if (entry.method === 0) data = stored;
        else {
          try {
            // The ceiling is the size the directory declared: an entry that inflates past it is a bomb or damaged.
            data = inflateRawSync(stored, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
          } catch (error) {
            if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new ZipError(`${JSON.stringify(name)} inflates past its declared size`);
            throw new ZipError(`${JSON.stringify(name)} could not be inflated`);
          }
        }
        if (data.length !== entry.uncompressedSize) throw new ZipError(`${JSON.stringify(name)} does not match its declared size`);
        if (crc32(data) !== entry.crc) throw new ZipError(`${JSON.stringify(name)} fails its checksum: the download is damaged`);
        return data;
      },
      close() {
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
