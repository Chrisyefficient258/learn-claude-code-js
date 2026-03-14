#!/usr/bin/env node
/**
 * s03_todo_write.js - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 */

import client from "./client.js";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import createDebug from "debug";

const debug = createDebug("agent:s03");
const debugTool = createDebug("agent:s03:tool");

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const SYSTEM = `You are a coding agent at ${WORKDIR}.
// TodoManager: Track tasks with status and nag reminders
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// TodoManager类：管理任务列表，支持状态跟踪和提醒
class TodoManager {
  // 构造函数：初始化任务列表
  constructor() {
    this.items = [];
  }

  update(items) {
    if (items.length > 20) throw new Error("Max 20 todos allowed");
    const validated = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const id = String(item.id || String(i + 1));

      if (!text) throw new Error(`Item ${id}: text required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") inProgressCount++;
      validated.push({ id, text, status });
    }

    if (inProgressCount > 1)
      throw new Error("Only one task can be in_progress at a time");
    this.items = validated;
    return this.render();
  }

  render() {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map((item) => {
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[
        item.status
      ];
      return `${marker} #${item.id}: ${item.text}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR))
    throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d)))
    return "Error: Dangerous command blocked";
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 50000000,
    });
    return output.trim() || "(no output)";
  } catch (e) {
    return (
      (e.stdout + e.stderr).trim().slice(0, 50000) || `Error: ${e.message}`
    );
  }
}

function runRead(path, limit = null) {
  try {
    const lines = readFileSync(safePath(path), "utf8").split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more)`]
        .join("\n")
        .slice(0, 50000);
    }
    return lines.join("\n").slice(0, 50000);
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
    let content = readFileSync(fp, "utf8");
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
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(path, old_text, new_text),
  todo: ({ items }) => TODO.update(items),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// Agent主循环：处理任务提醒和工具调用
async function agentLoop(messages) {
  let roundsSinceTodo = 0;

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        try {
          const output = handler
            ? handler(block.input)
            : `Unknown tool: ${block.name}`;
          console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
          if (block.name === "todo") usedTodo = true;
        } catch (e) {
          const output = `Error: ${e.message}`;
          console.log(`> ${block.name}: ${output}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const history = [];
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = () =>
    new Promise((resolve) => rl.question("\x1b[36ms03 >> \x1b[0m", resolve));

  while (true) {
    const query = await prompt();
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    history.push({ role: "user", content: query });
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
