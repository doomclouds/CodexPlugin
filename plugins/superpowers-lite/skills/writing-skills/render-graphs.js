#!/usr/bin/env node

/**
 * Render Graphviz diagrams from a skill's SKILL.md into SVG files.
 * Usage: render-graphs.js <skill-directory> [--combine]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function extractDotBlocks(markdown) {
  const blocks = [];
  const regex = /```dot\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const content = match[1].trim();
    const name = content.match(/digraph\s+(\w+)/)?.[1] ?? `graph_${blocks.length + 1}`;
    blocks.push({ name, content });
  }
  return blocks;
}

function extractGraphBody(dotContent) {
  const match = dotContent.match(/digraph\s+\w+\s*\{([\s\S]*)\}/);
  if (!match) return '';
  return match[1]
    .replace(/^\s*rankdir\s*=\s*\w+\s*;?\s*$/gm, '')
    .trim();
}

function combineGraphs(blocks, skillName) {
  const bodies = blocks.map((block, index) => {
    const indented = extractGraphBody(block.content)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    return `  subgraph cluster_${index} {\n    label="${block.name}";\n${indented}\n  }`;
  });
  return `digraph ${skillName}_combined {\n  rankdir=TB;\n  compound=true;\n  newrank=true;\n\n${bodies.join('\n\n')}\n}`;
}

function renderToSvg(dotContent) {
  try {
    return execFileSync('dot', ['-Tsvg'], {
      input: dotContent,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    console.error(`运行 dot 失败: ${error.message}`);
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const combine = args.includes('--combine');
  const skillDirArg = args.find((arg) => !arg.startsWith('--'));

  if (!skillDirArg) {
    console.error('用法: render-graphs.js <skill-directory> [--combine]');
    process.exit(1);
  }

  const skillDir = path.resolve(skillDirArg);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const skillName = path.basename(skillDir).replace(/-/g, '_');

  if (!fs.existsSync(skillFile)) {
    console.error(`文件不存在: ${skillFile}`);
    process.exit(1);
  }

  try {
    execFileSync('dot', ['-V'], { stdio: 'ignore' });
  } catch {
    console.error('未找到 Graphviz 命令 dot，请先安装 Graphviz。');
    process.exit(1);
  }

  const blocks = extractDotBlocks(fs.readFileSync(skillFile, 'utf8'));
  if (blocks.length === 0) {
    console.log(`未在 ${skillFile} 中发现 dot 代码块。`);
    return;
  }

  const outputDir = path.join(skillDir, 'diagrams');
  fs.mkdirSync(outputDir, { recursive: true });

  if (combine) {
    const source = combineGraphs(blocks, skillName);
    const svg = renderToSvg(source);
    if (!svg) process.exit(1);
    fs.writeFileSync(path.join(outputDir, `${skillName}_combined.svg`), svg);
    fs.writeFileSync(path.join(outputDir, `${skillName}_combined.dot`), source);
    console.log(`已生成组合图: ${path.join(outputDir, `${skillName}_combined.svg`)}`);
    return;
  }

  for (const block of blocks) {
    const svg = renderToSvg(block.content);
    if (!svg) process.exitCode = 1;
    else {
      fs.writeFileSync(path.join(outputDir, `${block.name}.svg`), svg);
      console.log(`已生成: ${path.join(outputDir, `${block.name}.svg`)}`);
    }
  }
}

main();
