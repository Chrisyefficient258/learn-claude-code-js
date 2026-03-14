#!/usr/bin/env node
/**
 * s06_context_compact.js - Compact
 * Three-layer compression pipeline so the agent can work forever
 */

import client from './client.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import createDebug from 'debug';

const debug = createDebug('agent:s06');
const debugTool = createDebug('agent:s06:tool');

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
// Context compression: micro/auto/manual strategies
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;
const THRESHOLD = 50000;
const TRANSCRIPT_DIR = resolve(WORKDIR, '.transcripts');
const KEEP_RECENT = 3;

function estimateTokens(messages) {
  return JSON.stringify(messages).length / 4;
}

// 微压缩：保留最近N条消息
function microCompact(messages) {
  const toolResults = [];
  messages.forEach((msg, msgIdx) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content.forEach((part, partIdx) => {
        if (part.type === 'tool_result') {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      });
    }
  });

  if (toolResults.length <= KEEP_RECENT) return messages;

  const toolNameMap = {};
  messages.forEach(msg => {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach(block => {
        if (block.type === 'tool_use') toolNameMap[block.id] = block.name;
      });
    }
  });

  const toClear = toolResults.slice(0, -KEEP_RECENT);
  toClear.forEach(({ result }) => {
    if (typeof result.content === 'string' && result.content.length > 100) {
      const toolName = toolNameMap[result.tool_use_id] || 'unknown';
      result.content = `[Previous: used ${toolName}]`;
    }
  });

  return messages;
}

// 自动压缩：根据token数量决定是否压缩
async function autoCompact(messages) {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  writeFileSync(transcriptPath, messages.map(m => JSON.stringify(m)).join('\n'));
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: 'user', content: `Summarize this conversation for continuity. Include: 1) What was accomplished, 2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n${conversationText}` }],
    max_tokens: 2000
  });

  const summary = response.content[0].text;
  return [
    { role: 'user', content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the context from the summary. Continuing.' }
  ];
}

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
  compact: () => 'Manual compression requested.'
};

const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read file contents.', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace exact text in file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'compact', description: 'Trigger manual conversation compression.', input_schema: { type: 'object', properties: { focus: { type: 'string', description: 'What to preserve in the summary' } } } }
];

// Agent主循环：支持三种压缩策略
async function agentLoop(messages) {
  while (true) {
    microCompact(messages);
    if (estimateTokens(messages) > THRESHOLD) {
      console.log('[auto_compact triggered]');
      messages.splice(0, messages.length, ...await autoCompact(messages));
    }

    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return;

    const results = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        if (block.name === 'compact') {
          manualCompact = true;
          var output = 'Compressing...';
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            var output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          } catch (e) {
            var output = `Error: ${e.message}`;
          }
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: 'user', content: results });

    if (manualCompact) {
      console.log('[manual compact]');
      messages.splice(0, messages.length, ...await autoCompact(messages));
    }
  }
}

// 主函数：启动交互式REPL
async function main() {
  const history = [];
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question('\x1b[36ms06 >> \x1b[0m', resolve));

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
