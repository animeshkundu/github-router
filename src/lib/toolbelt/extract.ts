/**
 * Minimal, dependency-free archive extraction for the toolbelt.
 *
 * We only ever need to pull ONE known binary out of a release archive,
 * so a full archiver dependency is overkill. These parsers find the
 * regular-file member whose basename matches the expected binary and
 * return its bytes — and **reject non-regular entries** (symlinks,
 * hardlinks, devices, directories), closing the malicious-archive
 * entry-type vector that a path-only zip-slip check would miss.
 */

import { gunzipSync, inflateRawSync } from "node:zlib"

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/")
  const idx = norm.lastIndexOf("/")
  return idx === -1 ? norm : norm.slice(idx + 1)
}

/**
 * Extract the first REGULAR-FILE tar member whose basename equals
 * `wantBasename` (optionally with a `.exe` suffix). Returns its bytes,
 * or null if absent. `buf` is the gzip-compressed tarball.
 */
export function extractTarGzMember(
  buf: Buffer,
  wantBasename: string,
): Buffer | null {
  let tar: Buffer
  try {
    tar = gunzipSync(buf)
  } catch {
    return null
  }
  const wants = new Set([wantBasename, `${wantBasename}.exe`])

  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // Two consecutive zero blocks → end of archive.
    if (header.every((b) => b === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeOctal = readTarString(header, 124, 12).trim()
    const size = parseInt(sizeOctal || "0", 8)
    const typeflag = String.fromCharCode(header[156])

    const dataStart = offset + 512
    // Regular file is typeflag '0' or '\0'. Anything else (symlink '2',
    // hardlink '1', char '3', block '4', dir '5', fifo '6') is rejected.
    const isRegular = typeflag === "0" || typeflag === "\0"
    if (isRegular && wants.has(baseName(fullName))) {
      if (dataStart + size > tar.length) return null
      return Buffer.from(tar.subarray(dataStart, dataStart + size))
    }

    // Advance past this entry's data (padded to 512).
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return null
}

function readTarString(block: Buffer, start: number, len: number): string {
  const slice = block.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? len : nul).toString("utf8")
}

/**
 * Extract the first REGULAR-FILE zip member whose basename equals
 * `wantBasename` (optionally `.exe`). Supports stored (0) and deflate
 * (8) compression. Rejects directories and unix-symlink entries.
 */
export function extractZipMember(
  buf: Buffer,
  wantBasename: string,
): Buffer | null {
  const wants = new Set([wantBasename, `${wantBasename}.exe`])

  // Locate End Of Central Directory (signature 0x06054b50). Scan back
  // from the end (no zip comment expected, but allow up to 64KB).
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const minStart = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return null

  const entryCount = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)

  const CEN_SIG = 0x02014b50
  for (let i = 0; i < entryCount; i++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== CEN_SIG) return null
    const method = buf.readUInt16LE(cd + 10)
    const compSize = buf.readUInt32LE(cd + 20)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const externalAttrs = buf.readUInt32LE(cd + 38)
    const localOffset = buf.readUInt32LE(cd + 42)
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString("utf8")

    const unixMode = (externalAttrs >>> 16) & 0xffff
    const isSymlink = (unixMode & 0xf000) === 0xa000
    const isDir = name.endsWith("/")

    if (!isSymlink && !isDir && wants.has(baseName(name))) {
      return readZipLocalEntry(buf, localOffset, method, compSize)
    }

    cd += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function readZipLocalEntry(
  buf: Buffer,
  localOffset: number,
  method: number,
  compSize: number,
): Buffer | null {
  const LOC_SIG = 0x04034b50
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
    return null
  }
  const nameLen = buf.readUInt16LE(localOffset + 26)
  const extraLen = buf.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLen + extraLen
  const comp = buf.subarray(dataStart, dataStart + compSize)
  try {
    if (method === 0) return Buffer.from(comp) // stored
    if (method === 8) return inflateRawSync(comp) // deflate
  } catch {
    return null
  }
  return null
}
