#!/usr/bin/env node
/**
 * s01_agent_loop.js - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 */

import { execSync } from "child_process";
import * as dotenv from "dotenv";
import createDebug from "debug";
import client from "./client.js";

dotenv.config({ override: true });

const debug = createDebug("agent:s01");
const debugTool = createDebug("agent:s01:tool");

// const client = new Anthropic({
//   apiKey: process.env.ANTHROPIC_API_KEY,
//   baseURL: process.env.ANTHROPIC_BASE_URL,
// });

const MODEL = process.env.MODEL_ID;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

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
];

// 执行bash命令，阻止危险操作
function runBash(command) {
  debugTool("Running bash: %s", command.slice(0, 100));
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    debugTool("Blocked dangerous command");
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 50000000,
    });
    debugTool("Command output: %d bytes", output.length);
    return output.trim() || "(no output)";
  } catch (e) {
    debugTool("Command error: %s", e.message);
    return (
      (e.stdout + e.stderr).trim().slice(0, 50000) || `Error: ${e.message}`
    );
  }
}

// Agent主循环：持续调用LLM并执行工具
async function agentLoop(messages) {
  while (true) {
    debug("Agent loop iteration, messages: %d", messages.length);
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    // console.dir(response);
    debug("Response stop_reason: %s", response.stop_reason);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${block.input.command}\x1b[0m`);
        const output = runBash(block.input.command);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// 主函数：启动交互式REPL
async function main() {
  const history = [];
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () =>
    new Promise((resolve) => rl.question("\x1b[36ms01 >> \x1b[0m", resolve));

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
