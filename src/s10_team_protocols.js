#!/usr/bin/env node
/**
 * s10_team_protocols.js - Team Protocols
 * Shutdown protocol and plan approval protocol with request_id correlation
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { randomBytes } from 'crypto';
import createDebug from 'debug';

const debug = createDebug('agent:s10');
const debugTool = createDebug('agent:s10:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const TEAM_DIR = resolve(WORKDIR, '.team');
const INBOX_DIR = join(TEAM_DIR, 'inbox');
const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;
// Team protocols: Shutdown and plan approval with request_id correlation
const VALID_MSG_TYPES = new Set(['message', 'broadcast', 'shutdown_request', 'shutdown_response', 'plan_approval_response']);

const shutdownRequests = {};
const planRequests = {};

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

  // 生成teammate并启动循环
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
    debug(`Spawned teammate '${name}' with role '${role}'`);
    this._teammateLoop(name, role, prompt).catch(() => {});
    return `Spawned '${name}' (role: ${role})`;
  }

  async _teammateLoop(name, role, prompt) {
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`;
    const messages = [{ role: 'user', content: prompt }];
    const tools = this._teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) messages.push({ role: 'user', content: JSON.stringify(msg) });
      if (shouldExit) break;

      try {
        var response = await client.messages.create({ model: MODEL, system: sysPrompt, messages, tools, max_tokens: 8000 });
      } catch {
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') break;

      const results = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const output = this._exec(name, block.name, block.input);
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output) });
          if (block.name === 'shutdown_response' && block.input.approve) shouldExit = true;
        }
      }
      messages.push({ role: 'user', content: results });
    }

    const member = this._findMember(name);
    if (member) {
      member.status = shouldExit ? 'shutdown' : 'idle';
      this._saveConfig();
    }
  }

  // 执行teammate的工具调用
  _exec(sender, toolName, args) {
    if (toolName === 'bash') return runBash(args.command);
    if (toolName === 'read_file') return runRead(args.path);
    if (toolName === 'write_file') return runWrite(args.path, args.content);
    if (toolName === 'edit_file') return runEdit(args.path, args.old_text, args.new_text);
    if (toolName === 'send_message') return BUS.send(sender, args.to, args.content, args.msg_type);
    if (toolName === 'read_inbox') return JSON.stringify(BUS.readInbox(sender), null, 2);
    if (toolName === 'shutdown_response') {
      const reqId = args.request_id;
      const approve = args.approve;
      if (shutdownRequests[reqId]) shutdownRequests[reqId].status = approve ? 'approved' : 'rejected';
      BUS.send(sender, 'lead', args.reason || '', 'shutdown_response', { request_id: reqId, approve });
      return `Shutdown ${approve ? 'approved' : 'rejected'}`;
    }
    if (toolName === 'plan_approval') {
      const planText = args.plan || '';
      const reqId = randomBytes(4).toString('hex');
      planRequests[reqId] = { from: sender, plan: planText, status: 'pending' };
      BUS.send(sender, 'lead', planText, 'plan_approval_response', { request_id: reqId, plan: planText });
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
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
      { name: 'shutdown_response', description: 'Respond to a shutdown request. Approve to shut down, reject to keep working.', input_schema: { type: 'object', properties: { request_id: { type: 'string' }, approve: { type: 'boolean' }, reason: { type: 'string' } }, required: ['request_id', 'approve'] } },
      { name: 'plan_approval', description: 'Submit a plan for lead approval. Provide plan text.', input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } }
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

// 处理关闭请求：生成request_id并发送给teammate
function handleShutdownRequest(teammate) {
  const reqId = randomBytes(4).toString('hex');
  shutdownRequests[reqId] = { target: teammate, status: 'pending' };
  debug(`Shutdown request ${reqId} sent to '${teammate}'`);
  BUS.send('lead', teammate, 'Please shut down gracefully.', 'shutdown_request', { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

// 处理计划审批：批准或拒绝teammate的计划
function handlePlanReview(requestId, approve, feedback = '') {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? 'approved' : 'rejected';
  BUS.send('lead', req.from, feedback, 'plan_approval_response', { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}

const TOOL_HANDLERS = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  // 生成teammate并启动循环
  spawn_teammate: ({ name, role, prompt }) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }) => BUS.send('lead', to, content, msg_type),
  read_inbox: () => JSON.stringify(BUS.readInbox('lead'), null, 2),
  broadcast: ({ content }) => BUS.broadcast('lead', content, TEAM.memberNames()),
  shutdown_request: ({ teammate }) => handleShutdownRequest(teammate),
  shutdown_response: ({ request_id }) => JSON.stringify(shutdownRequests[request_id] || { error: 'not found' }),
  plan_approval: ({ request_id, approve, feedback }) => handlePlanReview(request_id, approve, feedback)
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'spawn_teammate', description: 'Spawn a persistent teammate.', input_schema: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, prompt: { type: 'string' } }, required: ['name', 'role', 'prompt'] } },
  { name: 'list_teammates', description: 'List all teammates.', input_schema: { type: 'object', properties: {} } },
  { name: 'send_message', description: 'Send a message to a teammate.', input_schema: { type: 'object', properties: { to: { type: 'string' }, content: { type: 'string' }, msg_type: { type: 'string', enum: Array.from(VALID_MSG_TYPES) } }, required: ['to', 'content'] } },
  { name: 'read_inbox', description: "Read and drain the lead's inbox.", input_schema: { type: 'object', properties: {} } },
  { name: 'broadcast', description: 'Send a message to all teammates.', input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'shutdown_request', description: 'Request a teammate to shut down gracefully. Returns a request_id for tracking.', input_schema: { type: 'object', properties: { teammate: { type: 'string' } }, required: ['teammate'] } },
  { name: 'shutdown_response', description: 'Check the status of a shutdown request by request_id.', input_schema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] } },
  { name: 'plan_approval', description: 'Approve or reject a teammate\'s plan. Provide request_id + approve + optional feedback.', input_schema: { type: 'object', properties: { request_id: { type: 'string' }, approve: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['request_id', 'approve'] } }
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
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms10 >> \x1b[0m', resolve));

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
