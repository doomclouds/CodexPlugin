const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0; });
export function crc32(data: Uint8Array): number { let crc = 0xffffffff; for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!; return (crc ^ 0xffffffff) >>> 0; }
export function zipFiles(files: Array<{name:string;data:Buffer}>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset=0;
  for(const file of files) {
    const name=Buffer.from(file.name), crc=crc32(file.data), head=Buffer.alloc(30), entry=Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt32LE(crc,14);head.writeUInt32LE(file.data.length,18);head.writeUInt32LE(file.data.length,22);head.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.data.length,20);entry.writeUInt32LE(file.data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    local.push(head,name,file.data); central.push(entry,name); offset+=head.length+name.length+file.data.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
