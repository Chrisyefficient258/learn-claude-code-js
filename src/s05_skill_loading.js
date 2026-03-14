#!/usr/bin/env node
/**
 * s05_skill_loading.js - Skills
 * Two-layer skill injection that avoids bloating the system prompt
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s05');
const debugTool = createDebug('agent:s05:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
// SkillLoader: Two-layer loading (micro skills + full skills)
const SKILLS_DIR = join(WORKDIR, 'skills');

// SkillLoader类：两层技能加载（微技能+完整技能）
class SkillLoader {
  // 构造函数：初始化技能目录
  constructor(skillsDir) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  _loadAll() {
    if (!existsSync(this.skillsDir)) return;
    const findSkills = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) findSkills(path);
        else if (entry.name === 'SKILL.md') {
          const text = readFileSync(path, 'utf8');
          const { meta, body } = this._parseFrontmatter(text);
          const name = meta.name || dirname(path).split('/').pop();
          this.skills[name] = { meta, body, path };
        }
      }
    };
    findSkills(this.skillsDir);
  }

  _parseFrontmatter(text) {
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) return { meta: {}, body: text };
    const meta = {};
    for (const line of match[1].trim().split('\n')) {
      if (line.includes(':')) {
        const [key, val] = line.split(':', 2);
        meta[key.trim()] = val.trim();
      }
    }
    return { meta, body: match[2].trim() };
  }

  getDescriptions() {
    if (!Object.keys(this.skills).length) return '(no skills available)';
    return Object.entries(this.skills).map(([name, skill]) => {
      const desc = skill.meta.description || 'No description';
      const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : '';
      return `  - ${name}: ${desc}${tags}`;
    }).join('\n');
  }

  getContent(name) {
    const skill = this.skills[name];
    if (!skill) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(', ')}`;
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some(d => command.includes(d))) return 'Error: Dangerous command blocked';
  try {
    return execSync(command, { cwd: WORKDIR, encoding: 'utf8', timeout: 120000, maxBuffer: 50000000 }).trim() || '(no output)';
  } catch (e) {
    return (e.stdout + e.stderr).trim().slice(0, 50000) || `Error: ${e.message}`;
  }
}

function runRead(path, limit = null) {
  try {
    const lines = readFileSync(safePath(path), 'utf8').split('\n');
    if (limit && limit < lines.length) return [...lines.slice(0, limit), `... (${lines.length - limit} more)`].join('\n').slice(0, 50000);
    return lines.join('\n').slice(0, 50000);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runWrite(path, content) {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runEdit(path, oldText, newText) {
  try {
    const fp = safePath(path);
    let content = readFileSync(fp, 'utf8');
    if (!content.includes(oldText)) return `Error: Text not found in ${path}`;
    writeFileSync(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  load_skill: ({ name }) => SKILL_LOADER.getContent(name)
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'load_skill', description: 'Load specialized knowledge by name.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Skill name to load' } }, required: ['name'] } }
];

async function agentLoop(messages) {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return;

    const results = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const handler = TOOL_HANDLERS[block.name];
        try {
          const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output) });
        } catch (e) {
          const output = `Error: ${e.message}`;
          console.log(`> ${block.name}: ${output}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
        }
      }
    }
    messages.push({ role: 'user', content: results });
  }
}

async function main() {
  const history = [];
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms05 >> \x1b[0m', resolve));

  while (true) {
    const query = await prompt();
    if (!query || ['q', 'exit'].includes(query.trim().toLowerCase())) break;
    history.push({ role: 'user', content: query });
    await agentLoop(history);
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.text) console.log(block.text);
      }
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
