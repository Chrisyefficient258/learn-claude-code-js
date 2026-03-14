#!/usr/bin/env node
/**
 * s08_background_tasks.js - Background Tasks
 * Run commands in background threads with notification queue
 */

import client from './client.js';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s08');
const debugTool = createDebug('agent:s08:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;
// BackgroundManager: Run long commands async with notifications

// BackgroundManager类：后台执行长时间命令，异步通知结果
class BackgroundManager {
  constructor() {
    this.tasks = {};
    this.notificationQueue = [];
  }

  // 后台运行命令
  run(command) {
    const taskId = Math.random().toString(36).slice(2, 10);
    this.tasks[taskId] = { status: 'running', result: null, command };
    debug(`Starting background task ${taskId}: ${command.slice(0, 60)}`);

    exec(command, { cwd: WORKDIR, timeout: 300000, maxBuffer: 50000000 }, (error, stdout, stderr) => {
      const output = (stdout + stderr).trim().slice(0, 50000);
      const status = error ? (error.killed ? 'timeout' : 'error') : 'completed';
      this.tasks[taskId].status = status;
      this.tasks[taskId].result = output || '(no output)';
      debug(`Background task ${taskId} ${status}`);
      this.notificationQueue.push({
        task_id: taskId,
        status,
        command: command.slice(0, 80),
        result: (output || '(no output)').slice(0, 500)
      });
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  // 检查后台任务状态
  check(taskId = null) {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || '(running)'}`;
    }
    const lines = Object.entries(this.tasks).map(([tid, t]) => `${tid}: [${t.status}] ${t.command.slice(0, 60)}`);
    return lines.length ? lines.join('\n') : 'No background tasks.';
  }

  // 获取并清空通知队列
  drainNotifications() {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

const BG = new BackgroundManager();

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some(d => command.includes(d))) return 'Error: Dangerous command blocked';
  try {
    const { execSync } = require('child_process');
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
  // 后台运行命令
  background_run: ({ command }) => BG.run(command),
  check_background: ({ task_id }) => BG.check(task_id)
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command (blocking).', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'background_run', description: 'Run command in background. Returns task_id immediately.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'check_background', description: 'Check background task status. Omit task_id to list all.', input_schema: { type: 'object', properties: { task_id: { type: 'string' } } } }
];

async function agentLoop(messages) {
  while (true) {
  // 获取并清空通知队列
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
      messages.push({ role: 'user', content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: 'assistant', content: 'Noted background results.' });
    }

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
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms08 >> \x1b[0m', resolve));

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
