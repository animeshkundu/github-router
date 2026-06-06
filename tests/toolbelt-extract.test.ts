import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"

import { extractTarGzMember, extractZipMember } from "../src/lib/toolbelt/extract"

// ---- minimal tar builder ----
function tarHeader(
  name: string,
  size: number,
  typeflag: string,
  linkname = "",
): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100)
  buf.write("0000644\0", 100, 8)
  buf.write("0000000\0", 108, 8)
  buf.write("0000000\0", 116, 8)
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, 12)
  buf.write("00000000000\0", 136, 12)
  buf.write("        ", 148, 8) // checksum placeholder = spaces
  buf.write(typeflag, 156, 1)
  buf.write(linkname, 157, 100)
  buf.write("ustar\0", 257, 6)
  buf.write("00", 263, 2)
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8)
  return buf
}

function makeTarGz(
  entries: Array<{ name: string; data?: Buffer; typeflag: string; linkname?: string }>,
): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const size = e.data?.length ?? 0
    blocks.push(tarHeader(e.name, size, e.typeflag, e.linkname))
    if (e.data) {
      const padded = Buffer.alloc(Math.ceil(size / 512) * 512)
      e.data.copy(padded)
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks
  return gzipSync(Buffer.concat(blocks))
}

describe("extractTarGzMember", () => {
  test("extracts the regular-file member by basename (nested path)", () => {
    const tgz = makeTarGz([
      { name: "fd-v1.0/README.md", data: Buffer.from("readme"), typeflag: "0" },
      { name: "fd-v1.0/fd", data: Buffer.from("FD-BINARY"), typeflag: "0" },
    ])
    expect(extractTarGzMember(tgz, "fd")?.toString()).toBe("FD-BINARY")
  })

  test("rejects a symlink member with the matching basename (I8)", () => {
    const tgz = makeTarGz([
      { name: "pkg/fd", typeflag: "2", linkname: "/etc/passwd" }, // symlink
    ])
    expect(extractTarGzMember(tgz, "fd")).toBeNull()
  })

  test("returns null when the binary is absent", () => {
    const tgz = makeTarGz([
      { name: "pkg/other", data: Buffer.from("x"), typeflag: "0" },
    ])
    expect(extractTarGzMember(tgz, "fd")).toBeNull()
  })
})

// ---- minimal stored-zip builder (method 0, crc ignored for stored) ----
function makeZip(name: string, data: Buffer, externalAttrs = 0): Buffer {
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30 + nameBuf.length + data.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8) // method 0 = stored
  local.writeUInt32LE(0, 14) // crc (ignored for stored)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  nameBuf.copy(local, 30)
  data.copy(local, 30 + nameBuf.length)

  const cen = Buffer.alloc(46 + nameBuf.length)
  cen.writeUInt32LE(0x02014b50, 0)
  cen.writeUInt16LE(0, 10) // method 0
  cen.writeUInt32LE(0, 16) // crc
  cen.writeUInt32LE(data.length, 20)
  cen.writeUInt32LE(data.length, 24)
  cen.writeUInt16LE(nameBuf.length, 28)
  cen.writeUInt32LE(externalAttrs >>> 0, 38)
  cen.writeUInt32LE(0, 42) // local header offset
  nameBuf.copy(cen, 46)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8) // entries on disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(cen.length, 12) // cd size
  eocd.writeUInt32LE(local.length, 16) // cd offset

  return Buffer.concat([local, cen, eocd])
}

describe("extractZipMember", () => {
  test("extracts a stored member by basename", () => {
    const zip = makeZip("app/fd.exe", Buffer.from("WINBIN"))
    expect(extractZipMember(zip, "fd")?.toString()).toBe("WINBIN")
  })

  test("rejects a unix-symlink entry (external attrs S_IFLNK)", () => {
    // 0xA1FF0000 → high 16 bits = 0xA1FF, & 0xF000 === 0xA000 (symlink).
    const zip = makeZip("app/fd", Buffer.from("/etc/passwd"), 0xa1ff0000)
    expect(extractZipMember(zip, "fd")).toBeNull()
  })

  test("returns null when absent", () => {
    const zip = makeZip("app/other", Buffer.from("x"))
    expect(extractZipMember(zip, "fd")).toBeNull()
  })
})
