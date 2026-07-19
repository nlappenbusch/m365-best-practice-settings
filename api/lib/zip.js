/**
 * Minimaler ZIP-Encoder (Store-Methode, keine Kompression) — ohne externe
 * Dependency. Erzeugt ein Standard-ZIP, das Windows-Explorer, 7-Zip etc. oeffnen.
 * Reicht fuer unser Autopilot-Paket (Text + kleine Binaerdateien).
 */
const zlib = require("zlib");

// CRC32-Tabelle einmalig aufbauen
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * entries: [{ name, data }] — data ist Buffer oder string (utf8).
 * Rueckgabe: Buffer mit dem fertigen ZIP.
 */
function buildZip(entries) {
  const files = entries.map(e => ({
    name: Buffer.from(e.name, "utf8"),
    data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8")
  }));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const useDeflate = comp.length < f.data.length;
    const stored = useDeflate ? comp : f.data;
    const method = useDeflate ? 8 : 0;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);              // version needed
    lfh.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);              // mod time
    lfh.writeUInt16LE(0x21, 12);           // mod date (fixe 1980-01-01+)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);  // compressed size
    lfh.writeUInt32LE(f.data.length, 22);  // uncompressed size
    lfh.writeUInt16LE(f.name.length, 26);
    lfh.writeUInt16LE(0, 28);              // extra len
    chunks.push(lfh, f.name, stored);

    // Central directory record
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);
    cdr.writeUInt16LE(20, 4);              // version made by
    cdr.writeUInt16LE(20, 6);              // version needed
    cdr.writeUInt16LE(0x0800, 8);          // flags
    cdr.writeUInt16LE(method, 10);
    cdr.writeUInt16LE(0, 12);              // mod time
    cdr.writeUInt16LE(0x21, 14);           // mod date
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(stored.length, 20);
    cdr.writeUInt32LE(f.data.length, 24);
    cdr.writeUInt16LE(f.name.length, 28);
    cdr.writeUInt16LE(0, 30);              // extra len
    cdr.writeUInt16LE(0, 32);              // comment len
    cdr.writeUInt16LE(0, 34);              // disk number
    cdr.writeUInt16LE(0, 36);              // internal attrs
    cdr.writeUInt32LE(0, 38);              // external attrs
    cdr.writeUInt32LE(offset, 42);         // offset of local header
    central.push(cdr, f.name);

    offset += lfh.length + f.name.length + stored.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

module.exports = { buildZip };
