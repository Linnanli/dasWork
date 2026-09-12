import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";

const dosEpochDate = 0x0021;
const dosEpochTime = 0;
const directoryMode = 0o40755;

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export async function writeStoredZipArchive(path, inputEntries) {
  const entries = normalizeEntries(inputEntries);
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(path, { mode: 0o600 });
  const centralDirectory = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.path, "utf8");
      const data = entry.directory ? Buffer.alloc(0) : Buffer.from(entry.data);
      const crc = crc32(data);
      const localHeader = localFileHeader({ name, data, crc });
      centralDirectory.push(
        centralDirectoryHeader({
          name,
          data,
          crc,
          offset,
          mode: entry.directory ? directoryMode : entry.mode,
        }),
      );
      await write(output, localHeader);
      await write(output, data);
      offset += localHeader.byteLength + data.byteLength;
    }
    const centralDirectoryOffset = offset;
    for (const header of centralDirectory) {
      await write(output, header);
      offset += header.byteLength;
    }
    await write(
      output,
      endOfCentralDirectory({
        entries: centralDirectory.length,
        centralDirectoryBytes: offset - centralDirectoryOffset,
        centralDirectoryOffset,
      }),
    );
  } finally {
    output.end();
    await once(output, "close");
  }
}

export function listStoredZipEntries(buffer) {
  return readStoredZipArchive(buffer).map((entry) => entry.path);
}

export function readStoredZipArchive(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const output = [];
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central directory is invalid.");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    output.push({
      path,
      data: readStoredLocalFile({
        buffer,
        path,
        compressedSize,
        uncompressedSize,
        localOffset,
      }),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return output;
}

function normalizeEntries(inputEntries) {
  const paths = new Set();
  return [...inputEntries]
    .map((entry) => {
      const path = normalizeEntryPath(entry.path);
      if (paths.has(path)) throw new Error(`Duplicate ZIP entry: ${path}`);
      paths.add(path);
      const directory = path.endsWith("/");
      if (directory && entry.data) {
        throw new Error(`ZIP directory entry cannot carry data: ${path}`);
      }
      return {
        path,
        directory,
        data: entry.data ?? "",
        mode: entry.mode ?? 0o100644,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeEntryPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid ZIP entry path: ${path}`);
  }
  return path;
}

function localFileHeader({ name, data, crc }) {
  const header = Buffer.alloc(30 + name.byteLength);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dosEpochTime, 10);
  header.writeUInt16LE(dosEpochDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.byteLength, 18);
  header.writeUInt32LE(data.byteLength, 22);
  header.writeUInt16LE(name.byteLength, 26);
  name.copy(header, 30);
  return header;
}

function centralDirectoryHeader({ name, data, crc, offset, mode }) {
  const header = Buffer.alloc(46 + name.byteLength);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosEpochTime, 12);
  header.writeUInt16LE(dosEpochDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.byteLength, 20);
  header.writeUInt32LE(data.byteLength, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt32LE((mode & 0xffff) * 0x10000, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

function endOfCentralDirectory({
  entries,
  centralDirectoryBytes,
  centralDirectoryOffset,
}) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(entries, 8);
  header.writeUInt16LE(entries, 10);
  header.writeUInt32LE(centralDirectoryBytes, 12);
  header.writeUInt32LE(centralDirectoryOffset, 16);
  return header;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function write(stream, buffer) {
  if (buffer.byteLength === 0) return;
  if (!stream.write(buffer)) await once(stream, "drain");
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.byteLength - 65_557);
  for (
    let offset = buffer.byteLength - 22;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end of central directory was not found.");
}

function readStoredLocalFile({
  buffer,
  path,
  compressedSize,
  uncompressedSize,
  localOffset,
}) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`ZIP local header is invalid for ${path}.`);
  }
  const compressionMethod = buffer.readUInt16LE(localOffset + 8);
  if (compressionMethod !== 0) {
    throw new Error(`ZIP entry is not stored: ${path}.`);
  }
  if (compressedSize !== uncompressedSize) {
    throw new Error(`ZIP entry size mismatch: ${path}.`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  return buffer.subarray(dataOffset, dataOffset + uncompressedSize);
}
