#!/usr/bin/env node
/**
 * s11_autonomous_agents.js - Autonomous Agents
 * Idle cycle with task board polling and auto-claiming
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { randomBytes } from 'crypto';
import createDebug from 'debug';

const debug = createDebug('agent:s11');
const debugTool = createDebug('agent:s11:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const TEAM_DIR = resolve(WORKDIR, '.team');
const INBOX_DIR = join(TEAM_DIR, 'inbox');
const TASKS_DIR = resolve(WORKDIR, '.tasks');
const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;
const VALID_MSG_TYPES = new Set(['message', 'broadcast', 'shutdown_request', 'shutdown_response', 'plan_approval_response']);
const POLL_INTERVAL = 5000;
const IDLE_TIMEOUT = 60000;
// Autonomous agents: Idle polling and auto-claiming tasks

const shutdownRequests = {};
const planRequests = {};
let claimLock = false;

class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    mkdirSync(this.dir, { recursive: true });
  }

  send(sender, to, content, msgType = 'message', extra = {}) {
    if (!VALID_MSG_TYPES.has(msgType)) return `Error: Invalid type '${msgType}'`;
    const msg = { type: msgType, from: sender, content, timestamp: Date.now(), ...extra };
    appendFileSync(join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + '\n');
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name) {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const messages = readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    writeFileSync(inboxPath, '');
    return messages;
  }

  broadcast(sender, content, teammates) {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, 'broadcast');
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// 扫描未认领的任务：返回pending状态且无owner的任务
function scanUnclaimedTasks() {
  mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed = [];
  try {
    for (const file of readdirSync(TASKS_DIR)) {
      if (file.startsWith('task_') && file.endsWith('.json')) {
        const task = JSON.parse(readFileSync(join(TASKS_DIR, file), 'utf8'));
        if (task.status === 'pending' && !task.owner && (!task.blockedBy || !task.blockedBy.length)) {
          unclaimed.push(task);
        }
      }
    }
  } catch {}
  return unclaimed.sort((a, b) => a.id - b.id);
}

// 认领任务：使用锁机制防止并发冲突
function claimTask(taskId, owner) {
  if (claimLock) return 'Error: Claim in progress';
  claimLock = true;
  try {
    const path = join(TASKS_DIR, `task_${taskId}.json`);
    if (!existsSync(path)) return `Error: Task ${taskId} not found`;
    const task = JSON.parse(readFileSync(path, 'utf8'));
    task.owner = owner;
    task.status = 'in_progress';
    writeFileSync(path, JSON.stringify(task, null, 2));
    debug(`Task #${taskId} claimed by ${owner}`);
    return `Claimed task #${taskId} for ${owner}`;
  } finally {
    claimLock = false;
  }
}

function makeIdentityBlock(name, role, teamName) {
  return { role: 'user', content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>` };
}

class TeammateManager {
  constructor(teamDir) {
    this.dir = teamDir;
    mkdirSync(this.dir, { recursive: true });
    this.configPath = join(this.dir, 'config.json');
    this.config = this._loadConfig();
  }

  _loadConfig() {
    if (existsSync(this.configPath)) return JSON.parse(readFileSync(this.configPath, 'utf8'));
    return { team_name: 'default', members: [] };
  }

  _saveConfig() {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  _findMember(name) {
    return this.config.members.find(m => m.name === name);
  }

  _setStatus(name, status) {
    const member = this._findMember(name);
    if (member) {
      member.status = status;
      this._saveConfig();
    }
  }

  // 生成自主agent
  spawn(name, role, prompt) {
    let member = this._findMember(name);
    if (member) {
      if (!['idle', 'shutdown'].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = 'working';
      member.role = role;
    } else {
      member = { name, role, status: 'working' };
      this.config.members.push(member);
    }
    this._saveConfig();
    debug(`Spawned autonomous teammate '${name}' with role '${role}'`);
  // Agent主循环：工作-空闲-轮询
    this._loop(name, role, prompt).catch(() => {});
    return `Spawned '${name}' (role: ${role})`;
  }
  // Agent主循环：工作-空闲-轮询
  async _loop(name, role, prompt) {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages = [{ role: 'user', content: prompt }];
    const tools = this._teammateTools();

    while (true) {
      for (let i = 0; i < 50; i++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === 'shutdown_request') {
            this._setStatus(name, 'shutdown');
            return;
          }
          messages.push({ role: 'user', content: JSON.stringify(msg) });
        }

        try {
          var response = await client.messages.create({ model: MODEL, system: sysPrompt, messages, tools, max_tokens: 8000 });
        } catch {
          this._setStatus(name, 'idle');
          return;
        }

        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason !== 'tool_use') break;

        const results = [];
        let idleRequested = false;

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            if (block.name === 'idle') {
              idleRequested = true;
              var output = 'Entering idle phase. Will poll for new tasks.';
            } else {
              var output = this._exec(name, block.name, block.input);
            }
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: 'user', content: results });
        if (idleRequested) break;
      }

      this._setStatus(name, 'idle');
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

      for (let p = 0; p < polls; p++) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        const inbox = BUS.readInbox(name);
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg.type === 'shutdown_request') {
              this._setStatus(name, 'shutdown');
              return;
            }
            messages.push({ role: 'user', content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length) {
          const task = unclaimed[0];
          claimTask(task.id, name);
          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ''}</auto-claimed>`;
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: 'assistant', content: `I am ${name}. Continuing.` });
          }
          messages.push({ role: 'user', content: taskPrompt });
          messages.push({ role: 'assistant', content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this._setStatus(name, 'shutdown');
        return;
      }
      this._setStatus(name, 'working');
    }
  }

  // 执行工具调用
  _exec(sender, toolName, args) {
    if (toolName === 'bash') return runBash(args.command);
    if (toolName === 'read_file') return runRead(args.path);
    if (toolName === 'write_file') return runWrite(args.path, args.content);
    if (toolName === 'edit_file') return runEdit(args.path, args.old_text, args.new_text);
    if (toolName === 'send_message') return BUS.send(sender, args.to, args.content, args.msg_type);
    if (toolName === 'read_inbox') return JSON.stringify(BUS.readInbox(sender), null, 2);
    if (toolName === 'claim_task') return claimTask(args.task_id, sender);
    return `Unknown tool: ${toolName}`;
  }

  _teammateTools() {
    return [
      { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
      { name: 'send_message', description: 'Send message to a teammate.', input_schema: { type: 'object', properties: { to: { type: 'string' }, content: { type: 'string' }, msg_type: { type: 'string', enum: Array.from(VALID_MSG_TYPES) } }, required: ['to', 'content'] } },
      { name: 'read_inbox', description: 'Read and drain your inbox.', input_schema: { type: 'object', properties: {} } },
      { name: 'idle', description: 'Signal that you have no more work. Enters idle polling phase.', input_schema: { type: 'object', properties: {} } },
      { name: 'claim_task', description: 'Claim a task from the task board by ID.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } }
    ];
  }

  listAll() {
    if (!this.config.members.length) return 'No teammates.';
    return [`Team: ${this.config.team_name}`, ...this.config.members.map(m => `  ${m.name} (${m.role}): ${m.status}`)].join('\n');
  }

  memberNames() {
    return this.config.members.map(m => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

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

function runRead(path) {
  try {
    return readFileSync(safePath(path), 'utf8').slice(0, 50000);
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
  read_file: ({ path }) => runRead(path),
  write_file: ({ path, content }) => runWrite(path, content),
  // 生成自主agent
  spawn_teammate: ({ name, role, prompt }) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }) => BUS.send('lead', to, content, msg_type),
  read_inbox: () => JSON.stringify(BUS.readInbox('lead'), null, 2),
  broadcast: ({ content }) => BUS.broadcast('lead', content, TEAM.memberNames()),
  claim_task: ({ task_id }) => claimTask(task_id, 'lead')
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'spawn_teammate', description: 'Spawn an autonomous teammate.', input_schema: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, prompt: { type: 'string' } }, required: ['name', 'role', 'prompt'] } },
  { name: 'list_teammates', description: 'List all teammates.', input_schema: { type: 'object', properties: {} } },
  { name: 'send_message', description: 'Send a message to a teammate.', input_schema: { type: 'object', properties: { to: { type: 'string' }, content: { type: 'string' }, msg_type: { type: 'string', enum: Array.from(VALID_MSG_TYPES) } }, required: ['to', 'content'] } },
  { name: 'read_inbox', description: "Read and drain the lead's inbox.", input_schema: { type: 'object', properties: {} } },
  { name: 'broadcast', description: 'Send a message to all teammates.', input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'claim_task', description: 'Claim a task from the board by ID.', input_schema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } }
];

async function agentLoop(messages) {
  while (true) {
    const inbox = BUS.readInbox('lead');
    if (inbox.length) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: 'assistant', content: 'Noted inbox messages.' });
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
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms11 >> \x1b[0m', resolve));

  while (true) {
    const query = await prompt();
    if (!query) break;
    if (['q', 'exit'].includes(query.trim().toLowerCase())) break;
    if (query.trim() === '/team') {
      console.log(TEAM.listAll());
      continue;
    }
    if (query.trim() === '/inbox') {
      console.log(JSON.stringify(BUS.readInbox('lead'), null, 2));
      continue;
    }
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
