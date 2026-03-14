#!/usr/bin/env node
/**
 * s02_tool_use.js - Tools
 *
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 */

import client from "./client.js";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, relative } from "path";
import createDebug from "debug";

const debug = createDebug("agent:s02");
const debugTool = createDebug("agent:s02:tool");

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

function safePath(p) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR))
    throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

const dangerous = ["rm -rf /", "mkfs", "dd if="];

function runBash(command) {
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

function runRead(path, limit) {
  debugTool("Reading file: %s (limit: %s)", path, limit || "none");
  try {
    const lines = readFileSync(safePath(path), "utf8").split("\n");
    debugTool("Read %d lines", lines.length);
    if (limit && limit < lines.length) {
      return [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ]
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
    return `Wrote ${content.length} bytes to ${path}`;
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
  // Agent主循环：持续调用LLM并执行工具
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
];

async function agentLoop(messages) {
  while (true) {
    debug("Loop iteration, messages: %d", messages.length);
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    debug("Stop reason: %s", response.stop_reason);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input)
          : `Unknown tool: ${block.name}`;
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
      // 主函数：启动交互式REPL
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
    new Promise((resolve) => rl.question("\x1b[36ms02 >> \x1b[0m", resolve));

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
    console.log("22");
  }
  rl.close();
}

main().catch(console.error);
