// 从 API 响应里解出 base64 README，落成可读文件。
import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2];
const text = readFileSync(source, 'utf8');
const marker = '"content":"';
let index = 0;
let wrote = 0;
while (true) {
  const start = text.indexOf(marker, index);
  if (start === -1) break;
  const from = start + marker.length;
  const end = text.indexOf('"', from);
  if (end === -1) break;
  index = end + 1;
  const raw = text
    .slice(from, end)
    .replaceAll('\\\\n', '')
    .replaceAll('\\n', '');
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    continue;
  }
  if (!decoded.includes('Team Model Routing') && !decoded.includes('dsh-subagent-router')) continue;
  wrote += 1;
  const name = `readme-${String(wrote)}.md`;
  writeFileSync(name, decoded, 'utf8');
  console.log(`wrote ${name}: ${String(decoded.length)} chars`);
}
if (wrote === 0) console.log('no README payload found');
