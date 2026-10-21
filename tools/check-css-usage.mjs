#!/usr/bin/env node
/**
 * 检查 client.js 里 CSS 定义与使用点是否对得上：
 *  - 失效规则：CSS 里定义了，但 JSX 再没引用（count === 1，只出现在样式表里）
 *  - 未定义类：JSX 用了，但样式表里没有对应规则（白名单里的静态类除外）
 *
 * 只读，不改文件。用途：改完样式后确认没留下死代码、也没引用到不存在的类。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'client.js'), 'utf8');

/* 样式表里出现的类名：只认 CSS 字符串数组里 `.<name>` 开头的选择器片段。 */
const cssClasses = new Set();
for (const match of source.matchAll(/'\.?\.?([a-z][a-z0-9-]*)(?:\\?\.[a-z-]+)?\{/g)) {
  cssClasses.add(match[1]);
}
/* 上面这条会把 JS 里的其它 `{` 也扫进来，所以再按「类名是否符合本插件前缀」过滤。 */
const owned = [...cssClasses].filter((name) => /^(cm|cmp|cmt|mds)-/.test(name));

const counts = new Map();
for (const name of owned) {
  const hits = source.split(name).length - 1;
  counts.set(name, hits);
}

const dead = [...counts.entries()].filter(([, n]) => n <= 1).map(([name]) => name);

/* JSX 里用到的类：className 字符串 + 三元里的字符串字面量。
   下面两个标记不是 CSS 类，只是 id / React key，扫到会误报，直接跳过。 */
const NOT_CLASSES = new Set(['mds-', 'cm-style']);

const used = new Set();
for (const match of source.matchAll(/['"]([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)['"]/g)) {
  for (const token of match[1].split(' ')) {
    if (/^(cm|cmp|cmt|mds)-/.test(token) && !NOT_CLASSES.has(token)) used.add(token);
  }
}

const undefinedClasses = [...used].filter((name) => !owned.includes(name));

console.log('CSS 类总数:', owned.length);
console.log('疑似死规则:', dead.length === 0 ? '无' : dead.join(', '));
console.log('未定义的类:', undefinedClasses.length === 0 ? '无' : undefinedClasses.join(', '));
process.exit(dead.length === 0 && undefinedClasses.length === 0 ? 0 : 1);
