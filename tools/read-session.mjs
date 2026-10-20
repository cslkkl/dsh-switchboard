// 读取 DSH 的 session.v4.jsonl.zstd：日志是多帧 zstd（每帧一批事件），
// node 的流式解压只吐出第一帧，所以这里按魔数切帧、逐帧同步解压。
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 按 zstd 魔数切帧；帧之间没有额外分隔。 */
export function frameOffsets(buf) {
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (
      buf[i] === MAGIC[0] &&
      buf[i + 1] === MAGIC[1] &&
      buf[i + 2] === MAGIC[2] &&
      buf[i + 3] === MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** 把整个会话日志解成事件数组。 */
export function readSessionEvents(file) {
  const buf = readFileSync(file);
  const offsets = frameOffsets(buf);
  const events = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() !== '') events.push(JSON.parse(line));
    }
  }
  return events;
}

if (process.argv[1] && process.argv[1].endsWith('read-session.mjs')) {
  const file = process.argv[2];
  const events = readSessionEvents(file);
  const kinds = new Map();
  for (const event of events) kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
  console.log('events:', events.length);
  console.log('kinds:', [...kinds].map(([k, n]) => `${k}=${n}`).join(' '));
  for (const event of events) {
    if (event.type === 'session') console.log('header:', JSON.stringify(event).slice(0, 400));
    if (event.type === 'subagent/descriptor') console.log('descriptor:', JSON.stringify(event).slice(0, 400));
    if (event.type === 'request/header' || event.type === 'request' || event.type === 'llm/request') {
      console.log('request:', JSON.stringify(event).slice(0, 600));
    }
  }
}
