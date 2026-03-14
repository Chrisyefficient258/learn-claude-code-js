#!/usr/bin/env node
/**
 * s04_subagent.js - Subagents
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s04');
const debugTool = createDebug('agent:s04:tool');

const WORKDIR = process.cwd();
// Spawn subagents with isolated context for parallel work
const MODEL = process.env.MODEL_ID;
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some(d => command.includes(d))) return 'Error: Dangerous command blocked';
  try {
    const output = execSync(command, { cwd: WORKDIR, encoding: 'utf8', timeout: 120000, maxBuffer: 50000000 });
    return output.trim() || '(no output)';
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
    content = content.replace(oldText, newText);
    writeFileSync(fp, content);
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text)
};

const CHILD_TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } }
];

// 运行子agent：创建隔离的上下文执行任务
async function runSubagent(prompt) {
  const subMessages = [{ role: 'user', content: prompt }];
  let response;

  for (let i = 0; i < 30; i++) {
    response = await client.messages.create({ model: MODEL, system: SUBAGENT_SYSTEM, messages: subMessages, tools: CHILD_TOOLS, max_tokens: 8000 });
    subMessages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output).slice(0, 50000) });
      }
    }
    subMessages.push({ role: 'user', content: results });
  }

  return response.content.filter(b => b.text).map(b => b.text).join('') || '(no summary)';
}

const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  { name: 'task', description: 'Spawn a subagent with fresh context. It shares the filesystem but not conversation history.', input_schema: { type: 'object', properties: { prompt: { type: 'string' }, description: { type: 'string', description: 'Short description of the task' } }, required: ['prompt'] } }
];

// Agent主循环：持续调用LLM并执行工具
async function agentLoop(messages) {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: PARENT_TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return;

    const results = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let output;
        if (block.name === 'task') {
          const desc = block.input.description || 'subtask';
          console.log(`> task (${desc}): ${block.input.prompt.slice(0, 80)}`);
          output = await runSubagent(block.input.prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        }
        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: 'user', content: results });
  }
}

// 主函数：启动交互式REPL
async function main() {
  const history = [];
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms04 >> \x1b[0m', resolve));

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
