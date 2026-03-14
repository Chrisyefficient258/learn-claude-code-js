#!/usr/bin/env node
/**
 * s07_task_system.js - Tasks
 * Tasks persist as JSON files in .tasks/ so they survive context compression
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s07');
const debugTool = createDebug('agent:s07:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
// TaskManager: Tasks with dependencies and blocking
const TASKS_DIR = resolve(WORKDIR, '.tasks');
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// TaskManager类：任务管理，支持依赖关系和阻塞
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  _maxId() {
    try {
      const ids = readdirSync(this.dir)
        .filter(f => f.startsWith('task_') && f.endsWith('.json'))
        .map(f => parseInt(f.split('_')[1]))
        .filter(n => !isNaN(n));
      return ids.length ? Math.max(...ids) : 0;
    } catch {
      return 0;
    }
  }

  _load(taskId) {
    const path = join(this.dir, `task_${taskId}.json`);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`Task ${taskId} not found`);
    }
  }

  _save(task) {
    const path = join(this.dir, `task_${task.id}.json`);
    writeFileSync(path, JSON.stringify(task, null, 2));
  }

  // 创建新任务
  create(subject, description = '') {
    const task = {
      id: this._nextId,
      subject,
      description,
      status: 'pending',
      blockedBy: [],
      blocks: [],
      owner: ''
    };
    this._save(task);
    this._nextId++;
    return JSON.stringify(task, null, 2);
  }

  // 获取任务详情
  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  // 更新任务状态
  update(taskId, status = null, addBlockedBy = null, addBlocks = null) {
    const task = this._load(taskId);
    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      if (status === 'completed') this._clearDependency(taskId);
    }
    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this._save(blocked);
          }
        } catch {}
      }
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  _clearDependency(completedId) {
    try {
      for (const file of readdirSync(this.dir)) {
        if (file.startsWith('task_') && file.endsWith('.json')) {
          const task = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
          if (task.blockedBy?.includes(completedId)) {
            task.blockedBy = task.blockedBy.filter(id => id !== completedId);
            this._save(task);
          }
        }
      }
    } catch {}
  }

  // 列出所有任务
  listAll() {
    try {
      const tasks = readdirSync(this.dir)
        .filter(f => f.startsWith('task_') && f.endsWith('.json'))
        .map(f => JSON.parse(readFileSync(join(this.dir, f), 'utf8')))
        .sort((a, b) => a.id - b.id);

      if (!tasks.length) return 'No tasks.';

      const lines = tasks.map(t => {
        const marker = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }[t.status] || '[?]';
        const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy})` : '';
        return `${marker} #${t.id}: ${t.subject}${blocked}`;
      });
      return lines.join('\n');
    } catch {
      return 'No tasks.';
    }
  }
}

const TASKS = new TaskManager(TASKS_DIR);

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot'];
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
  // 创建新任务
  task_create: ({ subject, description }) => TASKS.create(subject, description),
  task_update: ({ task_id, status, addBlockedBy, addBlocks }) => TASKS.update(task_id, status, addBlockedBy, addBlocks),
  // 列出所有任务
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }) => TASKS.get(task_id)
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'task_create', description: 'Create a new task.', input_schema: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } },
  { name: 'task_update', description: "Update a task's status or dependencies.", input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, addBlockedBy: { type: 'array', items: { type: 'integer' } }, addBlocks: { type: 'array', items: { type: 'integer' } } }, required: ['task_id'] } },
  { name: 'task_list', description: 'List all tasks with status summary.', input_schema: { type: 'object', properties: {} } },
  { name: 'task_get', description: 'Get full details of a task by ID.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } }
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
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms07 >> \x1b[0m', resolve));

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
