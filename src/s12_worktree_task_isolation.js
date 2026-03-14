#!/usr/bin/env node
/**
 * s12_worktree_task_isolation.js - Worktree + Task Isolation
 * Directory-level isolation for parallel task execution
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s12');
const debugTool = createDebug('agent:s12:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;

function detectRepoRoot(cwd) {
  try {
    const result = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 10000 });
    return resolve(result.trim());
  } catch {
    return cwd;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR);
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work.`;
// Worktree isolation: Git worktrees + task binding + event logging

// EventBus类：记录worktree事件到JSONL日志
class EventBus {
  constructor(eventLogPath) {
    this.path = eventLogPath;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, '');
  }

  // 发送事件到日志
  emit(event, task = {}, worktree = {}, error = null) {
    const payload = { event, ts: Date.now(), task, worktree };
    if (error) payload.error = error;
    appendFileSync(this.path, JSON.stringify(payload) + '\n');
  }

  // 列出最近的事件
  listRecent(limit = 20) {
    const n = Math.max(1, Math.min(limit, 200));
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    return JSON.stringify(lines.slice(-n).map(l => JSON.parse(l)), null, 2);
  }
}

// TaskManager类：任务管理，支持与worktree绑定
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  _maxId() {
    try {
      const ids = readdirSync(this.dir).filter(f => f.startsWith('task_')).map(f => parseInt(f.split('_')[1])).filter(n => !isNaN(n));
      return ids.length ? Math.max(...ids) : 0;
    } catch {
      return 0;
    }
  }

  _path(taskId) {
    return join(this.dir, `task_${taskId}.json`);
  }

  _load(taskId) {
    const path = this._path(taskId);
    if (!existsSync(path)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  _save(task) {
    writeFileSync(this._path(task.id), JSON.stringify(task, null, 2));
  }

  create(subject, description = '') {
    const task = { id: this._nextId, subject, description, status: 'pending', owner: '', worktree: '', blockedBy: [], created_at: Date.now(), updated_at: Date.now() };
    this._save(task);
    this._nextId++;
    debug(`Created task #${task.id}: ${subject}`);
    return JSON.stringify(task, null, 2);
  }

  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  exists(taskId) {
    return existsSync(this._path(taskId));
  }

  update(taskId, status = null, owner = null) {
    const task = this._load(taskId);
    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) throw new Error(`Invalid status: ${status}`);
      task.status = status;
    }
    if (owner !== null) task.owner = owner;
    task.updated_at = Date.now();
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  // 绑定任务到worktree
  bindWorktree(taskId, worktree, owner = '') {
    const task = this._load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === 'pending') task.status = 'in_progress';
    task.updated_at = Date.now();
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId) {
    const task = this._load(taskId);
    task.worktree = '';
    task.updated_at = Date.now();
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    try {
      const tasks = readdirSync(this.dir).filter(f => f.startsWith('task_')).map(f => JSON.parse(readFileSync(join(this.dir, f), 'utf8'))).sort((a, b) => a.id - b.id);
      if (!tasks.length) return 'No tasks.';
      return tasks.map(t => {
        const marker = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }[t.status] || '[?]';
        const owner = t.owner ? ` owner=${t.owner}` : '';
        const wt = t.worktree ? ` wt=${t.worktree}` : '';
        return `${marker} #${t.id}: ${t.subject}${owner}${wt}`;
      }).join('\n');
    } catch {
      return 'No tasks.';
    }
  }
}

const TASKS = new TaskManager(join(REPO_ROOT, '.tasks'));
const EVENTS = new EventBus(join(REPO_ROOT, '.worktrees', 'events.jsonl'));

// WorktreeManager类：管理git worktree，实现任务隔离
class WorktreeManager {
  constructor(repoRoot, tasks, events) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = join(repoRoot, '.worktrees');
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, 'index.json');
    if (!existsSync(this.indexPath)) writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    this.gitAvailable = this._isGitRepo();
  }

  _isGitRepo() {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: this.repoRoot, encoding: 'utf8', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  _runGit(args) {
    if (!this.gitAvailable) throw new Error('Not in a git repository');
    const result = execSync(`git ${args.join(' ')}`, { cwd: this.repoRoot, encoding: 'utf8', timeout: 120000 });
    return result.trim() || '(no output)';
  }

  _loadIndex() {
    return JSON.parse(readFileSync(this.indexPath, 'utf8'));
  }

  _saveIndex(data) {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  _find(name) {
    const idx = this._loadIndex();
    return idx.worktrees.find(wt => wt.name === name);
  }

  // 创建git worktree
  create(name, taskId = null, baseRef = 'HEAD') {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error('Invalid worktree name');
    if (this._find(name)) throw new Error(`Worktree '${name}' already exists`);
    if (taskId !== null && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);

    const path = join(this.dir, name);
    const branch = `wt/${name}`;
    debug(`Creating worktree '${name}' at ${path} from ${baseRef}`);
    this.events.emit('worktree.create.before', taskId !== null ? { id: taskId } : {}, { name, base_ref: baseRef });

    try {
      this._runGit(['worktree', 'add', '-b', branch, path, baseRef]);
      const entry = { name, path, branch, task_id: taskId, status: 'active', created_at: Date.now() };
      const idx = this._loadIndex();
      idx.worktrees.push(entry);
      this._saveIndex(idx);
  // 绑定任务到worktree
      this.events.emit('worktree.create.after', taskId !== null ? { id: taskId } : {}, { name, path, branch, status: 'active' });
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit('worktree.create.failed', taskId !== null ? { id: taskId } : {}, { name, base_ref: baseRef }, e.message);
      throw e;
    }
  }

  // 列出所有worktree
  listAll() {
    const wts = idx.worktrees || [];
    if (!wts.length) return 'No worktrees in index.';
    return wts.map(wt => {
      const suffix = wt.task_id ? ` task=${wt.task_id}` : '';
      return `[${wt.status || 'unknown'}] ${wt.name} -> ${wt.path} (${wt.branch || '-'})${suffix}`;
    }).join('\n');
  }

  // 获取worktree的git状态
  status(name) {
    const wt = this._find(name);
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    try {
      return execSync('git status --short --branch', { cwd: wt.path, encoding: 'utf8', timeout: 60000 }).trim() || 'Clean worktree';
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  // 在worktree中执行命令
  run(name, command) {
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
    if (dangerous.some(d => command.includes(d))) return 'Error: Dangerous command blocked';
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    try {
      return execSync(command, { cwd: wt.path, encoding: 'utf8', timeout: 300000, maxBuffer: 50000000 }).trim().slice(0, 50000) || '(no output)';
    } catch (e) {
      return (e.stdout + e.stderr).trim().slice(0, 50000) || `Error: ${e.message}`;
    }
  }

  // 删除worktree
  remove(name, force = false, completeTask = false) {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    debug(`Removing worktree '${name}' (force=${force}, completeTask=${completeTask})`);

    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(wt.path);
      this._runGit(args);

      if (completeTask && wt.task_id !== null) {
        this.tasks.update(wt.task_id, 'completed');
        this.tasks.unbindWorktree(wt.task_id);
      }

      const idx = this._loadIndex();
      const item = idx.worktrees.find(w => w.name === name);
      if (item) {
        item.status = 'removed';
        item.removed_at = Date.now();
      }
      this._saveIndex(idx);
      this.events.emit('worktree.remove.after', wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path, status: 'removed' });
      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.emit('worktree.remove.failed', wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path }, e.message);
      throw e;
    }
  }

  // 标记worktree为保留状态
  keep(name) {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const idx = this._loadIndex();
    const item = idx.worktrees.find(w => w.name === name);
      item.status = 'kept';
      item.kept_at = Date.now();
    }
    this._saveIndex(idx);
    this.events.emit('worktree.keep', wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path, status: 'kept' });
    return JSON.stringify(item, null, 2);
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

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
  task_create: ({ subject, description }) => TASKS.create(subject, description),
  // 列出所有worktree
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }) => TASKS.get(task_id),
  task_update: ({ task_id, status, owner }) => TASKS.update(task_id, status, owner),
  task_bind_worktree: ({ task_id, worktree, owner }) => TASKS.bindWorktree(task_id, worktree, owner),
  worktree_create: ({ name, task_id, base_ref }) => WORKTREES.create(name, task_id, base_ref || 'HEAD'),
  // 列出所有worktree
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'task_create', description: 'Create a new task.', input_schema: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } },
  { name: 'task_list', description: 'List all tasks.', input_schema: { type: 'object', properties: {} } },
  { name: 'task_get', description: 'Get task details by ID.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } },
  { name: 'task_update', description: 'Update task status or owner.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, owner: { type: 'string' } }, required: ['task_id'] } },
  { name: 'task_bind_worktree', description: 'Bind a task to a worktree.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, worktree: { type: 'string' }, owner: { type: 'string' } }, required: ['task_id', 'worktree'] } },
  { name: 'worktree_create', description: 'Create a git worktree.', input_schema: { type: 'object', properties: { name: { type: 'string' }, task_id: { type: 'integer' }, base_ref: { type: 'string' } }, required: ['name'] } },
  { name: 'worktree_list', description: 'List worktrees.', input_schema: { type: 'object', properties: {} } },
  { name: 'worktree_status', description: 'Show git status for worktree.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'worktree_run', description: 'Run command in worktree.', input_schema: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' } }, required: ['name', 'command'] } },
  { name: 'worktree_remove', description: 'Remove a worktree.', input_schema: { type: 'object', properties: { name: { type: 'string' }, force: { type: 'boolean' }, complete_task: { type: 'boolean' } }, required: ['name'] } },
  { name: 'worktree_keep', description: 'Mark worktree as kept.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'worktree_events', description: 'List recent events.', input_schema: { type: 'object', properties: { limit: { type: 'integer' } } } }
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
  console.log(`Repo root: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) console.log('Note: Not in a git repo. worktree_* tools will return errors.');

  const history = [];
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms12 >> \x1b[0m', resolve));

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
