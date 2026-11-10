// Builds small zip files for tests, so no binary archive is committed. It writes exactly what
// the reader looks at, and can write the shapes the reader refuses.
import { writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * @param {string} file
 * @param {{ name: string, data: string | Buffer, method?: 0 | 8 | number, encrypted?: boolean, badCrc?: boolean, descriptor?: boolean, declaredSize?: number }[]} entries
 * @param {{ zip64Marker?: boolean, method?: number, encrypted?: boolean, badCrc?: boolean, descriptor?: boolean, multiDisk?: boolean }} [defaults]
 *   Options given here apply to every entry that does not set its own.
 */
export function writeZip(file, entries, defaults = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const option = (key) => entry[key] ?? defaults[key];
    const raw = Buffer.from(entry.data);
    const method = option("method") ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name);
    const crc = (crc32(raw) ^ (option("badCrc") ? 1 : 0)) >>> 0;
    const declared = entry.declaredSize ?? raw.length;
    const flags = (option("encrypted") ? 1 : 0) | (option("descriptor") ? 8 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // With a data descriptor the local header carries zeros and the real figures follow the data.
    if (!option("descriptor")) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(declared, 22);
    }
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    let written = 30 + name.length + body.length;
    if (option("descriptor")) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(declared, 12);
      parts.push(descriptor);
      written += 16;
    }

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(declared, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += written;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (defaults.multiDisk) end.writeUInt16LE(1, 4);
  end.writeUInt16LE(defaults.zip64Marker ? 0xffff : entries.length, 10);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...parts, directory, end]));
}
