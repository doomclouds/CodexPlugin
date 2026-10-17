import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { createCodeTemplate, validateCodeProject } from '../src/code-project.ts';
import type { CodeProject } from '../src/code-project.ts';
import { MAX_CODE_PROJECT_ARCHIVE_BYTES, MAX_CODE_PROJECT_ARCHIVE_EXPANDED_BYTES, parseCodeProjectArchive } from '../src/project-archive.ts';
import { zipFiles } from '../src/zip.ts';

// Independent ZIP fixtures use standard little-endian records and raw DEFLATE.
// They do not call the production ZIP writer to manufacture malformed headers.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let result = value; for (let index = 0; index < 8; index++) result = result & 1 ? 0xedb88320 ^ result >>> 1 : result >>> 1; return result >>> 0; });
function fixtureCrc(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
interface ArchiveFile { name: string | Buffer; data: Buffer; method?: number; descriptor?: 'signed' | 'unsigned'; flags?: number; attrs?: number; madeBy?: number; extra?: Buffer; compressedTail?: Buffer }
interface ZipRecord { name: string; local: number; central: number; data: number; end: number; descriptor?: number }
function fixtureZip(files: ArchiveFile[], comment = Buffer.alloc(0)) {
  const locals: Buffer[] = [], centrals: Buffer[] = [], records: ZipRecord[] = []; let position = 0;
  for (const file of files) {
    const name = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name), method = file.method ?? 0, extra = file.extra ?? Buffer.alloc(0), payload = Buffer.concat([method === 8 ? deflateRawSync(file.data) : file.data, file.compressedTail ?? Buffer.alloc(0)]);
    const flags = (file.flags ?? 0x800) | (file.descriptor ? 8 : 0), crc = fixtureCrc(file.data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!file.descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(file.data.length, 22); }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(file.madeBy ?? 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(file.attrs ?? 0, 38); central.writeUInt32LE(position, 42);
    const descriptor = file.descriptor ? Buffer.alloc(file.descriptor === 'signed' ? 16 : 12) : undefined;
    if (descriptor) { const offset = file.descriptor === 'signed' ? 4 : 0; if (offset) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, offset); descriptor.writeUInt32LE(payload.length, offset + 4); descriptor.writeUInt32LE(file.data.length, offset + 8); }
    records.push({ name: name.toString('utf8'), local: position, central: 0, data: position + local.length + name.length + extra.length, end: position + local.length + name.length + extra.length + payload.length, ...(descriptor ? { descriptor: position + local.length + name.length + extra.length + payload.length } : {}) });
    locals.push(local, name, extra, payload, ...(descriptor ? [descriptor] : [])); centrals.push(central, Buffer.concat([name, extra])); position += local.length + name.length + extra.length + payload.length + (descriptor?.length ?? 0);
  }
  const centralOffset = position; let centralPosition = centralOffset;
  records.forEach((record, index) => { record.central = centralPosition; centralPosition += centrals[index * 2]!.length + centrals[index * 2 + 1]!.length; });
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(comment.length, 20);
  return { bytes: Buffer.concat([...locals, directory, end, comment]), records, centralOffset, eocd: centralOffset + directory.length };
}
function projectFixture(): CodeProject {
  const project = createCodeTemplate('归档往返：原始内容', 'html');
  project.revision = 7;
  project.files = [
    { path: 'index.html', encoding: 'utf8', content: '<!doctype html><html lang="zh-CN"><h1>原始页面🙂</h1><script src="app.js"></script></html>\r\n' },
    { path: 'pages/阅读.html', encoding: 'utf8', content: '<!doctype html><h1>第二页</h1>\n' },
    { path: 'styles.css', encoding: 'utf8', content: 'h1 { color: #172a36; }\n' },
    { path: 'app.js', encoding: 'utf8', content: 'globalThis.__designArchiveExecutionCanary = "SOURCE EXECUTED";\n' },
    { path: 'assets/图像.png', encoding: 'base64', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XQAAAAASUVORK5CYII=' },
  ];
  project.pages = [{ id: 'page_home', name: '首页', entry: 'index.html', route: '/' }, { id: 'page_read', name: '阅读页', entry: 'pages/阅读.html', route: '/read' }]; project.defaultPageId = 'page_read';
  project.designSystem = { components: [{ name: 'Archive source', path: 'app.js', usage: 'Preserve the authored file without evaluating it.' }], notes: '保留真实CSS、组件引用与说明。' };
  project.comments = [{ id: 'comment_archive', file: 'pages/阅读.html', sourceId: 'source_comment_target', text: '归档中的评论', status: 'open', createdAt: project.createdAt }];
  return validateCodeProject(project);
}
function packageFiles(project = projectFixture()): ArchiveFile[] {
  return [
    { name: 'design-project.json', data: Buffer.from(JSON.stringify(project, null, 2)) },
    { name: 'prototype.html', data: Buffer.from('<!doctype html><script>globalThis.__designArchiveExecutionCanary="PROTOTYPE EXECUTED"</script><h1>Delivery only</h1>') },
    ...project.files.map(file => ({ name: `source/${file.path}`, data: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') })),
  ];
}
function rejectArchive(bytes: Uint8Array, label: string) { assert.throws(() => parseCodeProjectArchive(bytes), error => error instanceof Error, label); }
function mutate(bytes: Buffer, change: (copy: Buffer) => void) { const copy = Buffer.from(bytes); change(copy); return copy; }

test('the actual stored ZIP writer round-trips the current project and raw sources without executing either delivery or source', () => {
  const project = projectFixture(), files = packageFiles(project), bytes = zipFiles(files.map(file => ({ name: String(file.name), data: file.data })));
  assert.equal(fixtureCrc(Buffer.from('123456789')), 0xcbf43926, 'The independent CRC fixture uses the standard known vector.');
  const result = parseCodeProjectArchive(bytes);
  assert.deepEqual(result.project, project); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((globalThis as Record<string, unknown>).__designArchiveExecutionCanary, undefined);
  assert.equal(result.project.files.find(file => file.path === 'assets/图像.png')!.content, project.files.at(-1)!.content);
  const padded = Buffer.concat([Buffer.alloc(9, 1), bytes, Buffer.alloc(9, 2)]), view = new Uint8Array(padded.buffer, padded.byteOffset + 9, bytes.length);
  assert.deepEqual(parseCodeProjectArchive(view), result, 'The parser consumes only the supplied Uint8Array view, not its backing buffer.');
});

test('standard stored and deflated entries accept signed or unsigned data descriptors, UTF-8 names, folder entries and ZIP comments', () => {
  const project = projectFixture();
  for (const method of [0, 8]) for (const descriptor of [undefined, 'signed', 'unsigned'] as const) {
    const files: ArchiveFile[] = [
      ...['source/', 'source/pages/', 'source/assets/'].map(name => ({ name, data: Buffer.alloc(0), attrs: 0x10 | (0o40755 << 16) >>> 0, madeBy: 0x031e })),
      ...packageFiles(project).map(file => ({ ...file, method, descriptor })),
    ];
    const { bytes } = fixtureZip(files, Buffer.from('合法归档注释'));
    assert.deepEqual(parseCodeProjectArchive(bytes).project, project, `method=${method}, descriptor=${descriptor ?? 'none'}`);
  }
});

test('CRC, local and central fields, descriptor values and truncated structures must agree before a project is returned', () => {
  const archive = fixtureZip(packageFiles()), first = archive.records[0]!;
  const cases: Array<[string, (bytes: Buffer) => void]> = [
    ['central CRC', bytes => bytes.writeUInt32LE((bytes.readUInt32LE(first.central + 16) ^ 1) >>> 0, first.central + 16)],
    ['local CRC', bytes => bytes.writeUInt32LE((bytes.readUInt32LE(first.local + 14) ^ 1) >>> 0, first.local + 14)],
    ['local method', bytes => bytes.writeUInt16LE(8, first.local + 8)],
    ['local flags', bytes => bytes.writeUInt16LE(0, first.local + 6)],
    ['local filename', bytes => { bytes[first.local + 30] = 0x58; }],
    ['local compressed size', bytes => bytes.writeUInt32LE(1, first.local + 18)],
    ['local expanded size', bytes => bytes.writeUInt32LE(1, first.local + 22)],
    ['data CRC', bytes => { bytes[first.data] = bytes[first.data]! ^ 1; }],
    ['central signature', bytes => bytes.writeUInt32LE(0, first.central)],
    ['central size out of bounds', bytes => bytes.writeUInt32LE(0xffffffff, first.central + 20)],
    ['overlapping local records', bytes => bytes.writeUInt32LE(first.local, archive.records[1]!.central + 42)],
    ['central local offset outside archive', bytes => bytes.writeUInt32LE(bytes.length + 20, first.central + 42)],
    ['wrong central directory count', bytes => bytes.writeUInt16LE(1, archive.eocd + 10)],
    ['wrong central directory size', bytes => bytes.writeUInt32LE(1, archive.eocd + 12)],
    ['wrong central directory location', bytes => bytes.writeUInt32LE(1, archive.eocd + 16)],
  ];
  for (const [label, change] of cases) rejectArchive(mutate(archive.bytes, change), label);
  for (const length of [0, 3, 29, archive.centralOffset, archive.bytes.length - 1]) rejectArchive(archive.bytes.subarray(0, length), `truncated at ${length}`);
  for (const descriptor of ['signed', 'unsigned'] as const) {
    const sample = fixtureZip(packageFiles().map(file => ({ ...file, method: 8, descriptor }))), entry = sample.records[0]!, offset = entry.descriptor! + (descriptor === 'signed' ? 4 : 0);
    for (const field of [0, 4, 8]) rejectArchive(mutate(sample.bytes, bytes => bytes.writeUInt32LE((bytes.readUInt32LE(offset + field) ^ 1) >>> 0, offset + field)), `${descriptor} descriptor field ${field}`);
  }
});

test('encrypted, symlink, multi-disk, ZIP64 and unsupported compression archives are rejected', () => {
  const files = packageFiles();
  rejectArchive(fixtureZip(files.map(file => ({ ...file, flags: 0x801 }))).bytes, 'encrypted entries');
  rejectArchive(fixtureZip(files.map((file, index) => index === 0 ? { ...file, madeBy: 0x031e, attrs: (0o120777 << 16) >>> 0 } : file)).bytes, 'Unix symbolic links');
  rejectArchive(fixtureZip(files.map((file, index) => index === 0 ? { ...file, method: 12 } : file)).bytes, 'unsupported compression method');
  const archive = fixtureZip(files), first = archive.records[0]!;
  for (const [label, change] of [
    ['multiple disks', (bytes: Buffer) => { bytes.writeUInt16LE(1, archive.eocd + 4); bytes.writeUInt16LE(1, archive.eocd + 6); }],
    ['central entry disk', (bytes: Buffer) => bytes.writeUInt16LE(1, first.central + 34)],
    ['ZIP64 entry size sentinel', (bytes: Buffer) => { bytes.writeUInt32LE(0xffffffff, first.central + 24); bytes.writeUInt32LE(0xffffffff, first.local + 22); }],
    ['ZIP64 EOCD sentinel', (bytes: Buffer) => { bytes.writeUInt16LE(0xffff, archive.eocd + 8); bytes.writeUInt16LE(0xffff, archive.eocd + 10); }],
  ] as const) rejectArchive(mutate(archive.bytes, change), label);
});

test('extraction versions agree exactly and reflect the actual storage or descriptor feature', () => {
  for (const method of [0, 8]) for (const descriptor of [undefined, 'signed'] as const) {
    const archive = fixtureZip(packageFiles().map(file => ({ ...file, method, descriptor }))), first = archive.records[0]!;
    rejectArchive(mutate(archive.bytes, bytes => bytes.writeUInt16LE(10, first.local + 4)), `central 20 and local 10 disagree: method=${method}, descriptor=${descriptor}`);
    for (const version of [0, 19, 21]) rejectArchive(mutate(archive.bytes, bytes => { bytes.writeUInt16LE(version, first.local + 4); bytes.writeUInt16LE(version, first.central + 6); }), `unsupported extraction version ${version}`);
    const legacyStoredVersion = mutate(archive.bytes, bytes => { bytes.writeUInt16LE(10, first.local + 4); bytes.writeUInt16LE(10, first.central + 6); });
    if (method === 0 && !descriptor) assert.deepEqual(parseCodeProjectArchive(legacyStoredVersion).project, parseCodeProjectArchive(archive.bytes).project, 'Version 1.0 is an ordinary stored ZIP feature, not a product-format migration.');
    else rejectArchive(legacyStoredVersion, 'DEFLATE and data descriptors need extraction version 2.0');
  }
});

test('extra fields are bounded, ordinary timestamps remain valid and DEFLATE must consume exactly its declared input', () => {
  const project = projectFixture(), files = packageFiles(project), timestamp = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(parseCodeProjectArchive(fixtureZip(files.map(file => ({ ...file, method: 8, extra: timestamp }))).bytes).project, project, 'An ordinary extended timestamp does not change project bytes or metadata.');
  for (const extra of [Buffer.from([1, 0, 0, 0]), Buffer.from([0x55, 0x54, 10, 0, 1]), Buffer.from([0x55])]) rejectArchive(fixtureZip(files.map((file, index) => index === 0 ? { ...file, extra } : file)).bytes, 'ZIP64 or truncated extra field');
  for (const compressedTail of [Buffer.from([0]), deflateRawSync(Buffer.from('second stream'))]) rejectArchive(fixtureZip(files.map((file, index) => index === 0 ? { ...file, method: 8, compressedTail } : file)).bytes, 'trailing or concatenated DEFLATE bytes cannot hide inside a declared payload');
});

test('duplicate names, unsafe paths, malformed UTF-8 and unexpected files never enter the project namespace', () => {
  const files = packageFiles();
  rejectArchive(fixtureZip([...files, files[0]!]).bytes, 'duplicate manifest');
  rejectArchive(fixtureZip([...files, files[2]!]).bytes, 'duplicate source');
  for (const name of ['../outside.js', '/source/app.js', 'source/../../outside.js', 'source\\app.js', 'source//app.js', 'source/./app.js', 'source/%2e%2e/outside.js', 'C:/source/app.js', 'source/.codex/auth.json', 'source/app.js\0hidden', 'source/INDEX.html', 'unrecognized.txt']) rejectArchive(fixtureZip([...files, { name, data: Buffer.from('not a recognized project member') }]).bytes, name);
  rejectArchive(fixtureZip([...files, { name: Buffer.from([0xff, 0xfe, 0x2e, 0x6a, 0x73]), data: Buffer.from('invalid name') }]).bytes, 'malformed UTF-8 filename');
  rejectArchive(fixtureZip([...files, { name: 'source/index.html/', data: Buffer.alloc(0), attrs: 0x10 }]).bytes, 'a directory cannot shadow a source file');
});

test('preamble, trailing garbage and an unlisted local file cannot hide outside the central directory', () => {
  const archive = fixtureZip(packageFiles());
  rejectArchive(Buffer.concat([Buffer.from('preamble'), archive.bytes]), 'unadjusted preamble');
  const prefixed = Buffer.concat([Buffer.from('prefix'), archive.bytes]);
  for (const record of archive.records) prefixed.writeUInt32LE(record.local + 6, record.central + 6 + 42);
  prefixed.writeUInt32LE(archive.centralOffset + 6, archive.eocd + 6 + 16);
  rejectArchive(prefixed, 'a structurally adjusted self-extracting preamble remains disallowed');
  rejectArchive(Buffer.concat([archive.bytes, Buffer.from('trailing')]), 'bytes after the EOCD comment');
  const hidden = fixtureZip([{ name: 'hidden.txt', data: Buffer.from('unlisted local body') }]), orphan = hidden.bytes.subarray(0, hidden.centralOffset);
  const withOrphan = Buffer.concat([archive.bytes.subarray(0, archive.centralOffset), orphan, archive.bytes.subarray(archive.centralOffset)]);
  withOrphan.writeUInt32LE(archive.centralOffset + orphan.length, archive.eocd + orphan.length + 16);
  rejectArchive(withOrphan, 'unlisted local record before the central directory');
});

test('the manifest and source closure agree byte for byte, with no old schema migration or prototype-as-source fallback', () => {
  const project = projectFixture(), files = packageFiles(project);
  rejectArchive(fixtureZip(files.filter(file => file.name !== 'design-project.json')).bytes, 'missing manifest');
  rejectArchive(fixtureZip(files.filter(file => file.name !== 'prototype.html')).bytes, 'missing prototype delivery');
  rejectArchive(fixtureZip(files.filter(file => file.name !== 'source/index.html')).bytes, 'missing source');
  rejectArchive(fixtureZip(files.map(file => file.name === 'source/index.html' ? { ...file, data: Buffer.from(project.files[0]!.content.replace('\r\n', '\n')) } : file)).bytes, 'line-ending changes are not the same source bytes');
  rejectArchive(fixtureZip(files.map(file => file.name === 'source/assets/图像.png' ? { ...file, data: Buffer.concat([file.data, Buffer.from([1])]) } : file)).bytes, 'binary bytes differ');
  rejectArchive(fixtureZip(files.map(file => file.name === 'design-project.json' ? { ...file, data: Buffer.from('{not JSON') } : file)).bytes, 'malformed manifest');
  for(const schemaVersion of [1,2]){
    const bytes=fixtureZip(files.map(file=>file.name==='design-project.json'?{...file,data:Buffer.from(JSON.stringify({...project,schemaVersion}))}:file)).bytes;
    const original=Buffer.from(bytes);
    assert.throws(()=>parseCodeProjectArchive(bytes),(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='UNSUPPORTED_FORMAT',`Unsupported schema ${schemaVersion} must be diagnosed directly.`);
    assert.deepEqual(bytes,original,'Reading unsupported user archives must not mutate their bytes.');
  }
});

test('archive transfer and expanded budgets reject oversized or dishonestly declared DEFLATE content', () => {
  assert.equal(MAX_CODE_PROJECT_ARCHIVE_BYTES, 32 * 1024 * 1024); assert.equal(MAX_CODE_PROJECT_ARCHIVE_EXPANDED_BYTES, 32 * 1024 * 1024);
  rejectArchive(Buffer.alloc(MAX_CODE_PROJECT_ARCHIVE_BYTES + 1), 'transfer budget');
  const files = packageFiles(), bomb = fixtureZip(files.map(file => file.name === 'prototype.html' ? { ...file, method: 8, data: Buffer.alloc(MAX_CODE_PROJECT_ARCHIVE_EXPANDED_BYTES + 1, 0x61) } : file));
  assert.ok(bomb.bytes.length < MAX_CODE_PROJECT_ARCHIVE_BYTES, 'The expanded-budget fixture is a small, genuinely compressed ZIP.');
  rejectArchive(bomb.bytes, 'declared expanded budget');
  const entry = bomb.records.find(record => record.name === 'prototype.html')!;
  rejectArchive(mutate(bomb.bytes, bytes => { bytes.writeUInt32LE(1, entry.local + 22); bytes.writeUInt32LE(1, entry.central + 24); }), 'actual inflate output cannot exceed its declared size or the total budget');
});
