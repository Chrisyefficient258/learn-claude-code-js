# learn-claude-code-js

学习claude-code推荐路径

- [入门《Claude Code 完全指南：使用方式、技巧与最佳实践》](https://www.cnblogs.com/knqiufan/p/19449849)
- [进阶《你不知道的 Claude Code：架构、治理与工程实践》](https://x.com/HiTw93/status/2032091246588518683)
- [原理《learn-claude-code》](https://github.com/shareAI-lab/learn-claude-code)


由于learn-claude-code是python写的，我又是Node.js技术栈，所以搞个learn-claude-code-js版本来学习原理更方便。src是按照原agents目录直接迁移过来的。只增加了client.js。

## why fix client.js

我的cc用的是中转站https://foxcode.rjj.cc/
所以，直接用@anthropic-ai/sdk会报403错误。

首先测试

```sh
curl https://code.newcli.com/claude/aws/v1/messages \
  -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 10,
    "messages": [
      {"role": "user", "content": "hello"}
    ]
  }'
```

返回结果

```json
{
  "content": [
    {
      "text": "Hey! How can I help you today?",
      "type": "text"
    }
  ],
  "model": "claude-opus-4-6",
  "role": "assistant",
  "stop_reason": "max_tokens",
  "stop_sequence": null,
  "type": "message",
  "usage": {
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 0
    },
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "inference_geo": "not_available",
    "input_tokens": 4,
    "output_tokens": 11,
    "service_tier": "standard"
  }
}
```

然后快速mock一个src/client.js即可

## prepare

create src/.env

```
ANTHROPIC_BASE_URL=https://code.newcli.com/claude/aws/v1
ANTHROPIC_API_KEY=your key
MODEL_ID=claude-sonnet-4-6
ANTHROPIC_API_VERSION=2023-06-01
```

## run

```sh
$ npm run s01
```

以下是copy原repo内容，自己对比着练习即可。

## agent模式

```
                    THE AGENT PATTERN
                    =================

    User --> messages[] --> LLM --> response
                                      |
                            stop_reason == "tool_use"?
                           /                          \
                         yes                           no
                          |                             |
                    execute tools                    return text
                    append results
                    loop back -----------------> messages[]


    这是最小循环。每个 AI 编程 Agent 都需要这个循环。
    生产级 Agent 还会叠加策略、权限与生命周期层。
```

**12 个递进式课程, 从简单循环到隔离化的自治执行。**
**每个课程添加一个机制。每个机制有一句格言。**

> **s01** &nbsp; *"One loop & Bash is all you need"* &mdash; 一个工具 + 一个循环 = 一个智能体
>
> **s02** &nbsp; *"加一个工具, 只加一个 handler"* &mdash; 循环不用动, 新工具注册进 dispatch map 就行
>
> **s03** &nbsp; *"没有计划的 agent 走哪算哪"* &mdash; 先列步骤再动手, 完成率翻倍
>
> **s04** &nbsp; *"大任务拆小, 每个小任务干净的上下文"* &mdash; 子智能体用独立 messages[], 不污染主对话
>
> **s05** &nbsp; *"用到什么知识, 临时加载什么知识"* &mdash; 通过 tool_result 注入, 不塞 system prompt
>
> **s06** &nbsp; *"上下文总会满, 要有办法腾地方"* &mdash; 三层压缩策略, 换来无限会话
>
> **s07** &nbsp; *"大目标要拆成小任务, 排好序, 记在磁盘上"* &mdash; 文件持久化的任务图, 为多 agent 协作打基础
>
> **s08** &nbsp; *"慢操作丢后台, agent 继续想下一步"* &mdash; 后台线程跑命令, 完成后注入通知
>
> **s09** &nbsp; *"任务太大一个人干不完, 要能分给队友"* &mdash; 持久化队友 + 异步邮箱
>
> **s10** &nbsp; *"队友之间要有统一的沟通规矩"* &mdash; 一个 request-response 模式驱动所有协商
>
> **s11** &nbsp; *"队友自己看看板, 有活就认领"* &mdash; 不需要领导逐个分配, 自组织
>
> **s12** &nbsp; *"各干各的目录, 互不干扰"* &mdash; 任务管目标, worktree 管目录, 按 ID 绑定

---

## 核心模式

python version

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM,
            messages=messages, tools=TOOLS,
        )
        messages.append({"role": "assistant",
                         "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = TOOL_HANDLERS[block.name](**block.input)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

js version

```js
// Agent主循环：持续调用LLM并执行工具
async function agentLoop(messages) {
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
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const output = runBash(block.input.command);
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
```

每个课程在这个循环之上叠加一个机制 -- 循环本身始终不变。

## 范围说明 (重要)

本仓库是一个 0->1 的学习型项目，用于从零构建 nano Claude Code-like agent。
为保证学习路径清晰，仓库有意简化或省略了部分生产机制：

- 完整事件 / Hook 总线 (例如 PreToolUse、SessionStart/End、ConfigChange)。
  s12 仅提供教学用途的最小 append-only 生命周期事件流。
- 基于规则的权限治理与信任流程
- 会话生命周期控制 (resume/fork) 与更完整的 worktree 生命周期控制
- 完整 MCP 运行时细节 (transport/OAuth/资源订阅/轮询)

仓库中的团队 JSONL 邮箱协议是教学实现，不是对任何特定生产内部实现的声明。

## 快速开始

```sh
git clone https://github.com/shareAI-lab/learn-claude-code
cd learn-claude-code
pip install -r requirements.txt
cp .env.example .env   # 编辑 .env 填入你的 ANTHROPIC_API_KEY

python agents/s01_agent_loop.py       # 从这里开始
python agents/s12_worktree_task_isolation.py  # 完整递进终点
python agents/s_full.py               # 总纲: 全部机制合一
```

### Web 平台

交互式可视化、分步动画、源码查看器, 以及每个课程的文档。

```sh
cd web && npm install && npm run dev   # http://localhost:3000
```

## 学习路径

```
第一阶段: 循环                       第二阶段: 规划与知识
==================                   ==============================
s01  Agent 循环              [1]     s03  TodoWrite               [5]
     while + stop_reason                  TodoManager + nag 提醒
     |                                    |
     +-> s02  Tool Use            [4]     s04  子智能体             [5]
              dispatch map: name->handler     每个子智能体独立 messages[]
                                              |
                                         s05  Skills               [5]
                                              SKILL.md 通过 tool_result 注入
                                              |
                                         s06  Context Compact      [5]
                                              三层上下文压缩

第三阶段: 持久化                     第四阶段: 团队
==================                   =====================
s07  任务系统                [8]     s09  智能体团队             [9]
     文件持久化 CRUD + 依赖图             队友 + JSONL 邮箱
     |                                    |
s08  后台任务                [6]     s10  团队协议               [12]
     守护线程 + 通知队列                  关机 + 计划审批 FSM
                                          |
                                     s11  自治智能体             [14]
                                          空闲轮询 + 自动认领
                                     |
                                     s12  Worktree 隔离          [16]
                                          任务协调 + 按需隔离执行通道

                                     [N] = 工具数量
```

## 项目结构

```
learn-claude-code-js/
|
|-- src/                        # Python 参考实现 (s01-s12 + s_full 总纲)
|-- docs/{en,zh,ja}/               # 心智模型优先的文档 (3 种语言)
|-- web/                           # 交互式学习平台 (Next.js)
|-- skills/                        # s05 的 Skill 文件
+-- .github/workflows/ci.yml      # CI: 类型检查 + 构建
```

## 文档

心智模型优先: 问题、方案、ASCII 图、最小化代码。
[English](./docs/en/) | [中文](./) | [日本語](./docs/ja/)

| 课程 | 主题 | 格言 |
|------|------|------|
| [s01](./s01-the-agent-loop.md) | Agent 循环 | *One loop & Bash is all you need* |
| [s02](./s02-tool-use.md) | Tool Use | *加一个工具, 只加一个 handler* |
| [s03](./s03-todo-write.md) | TodoWrite | *没有计划的 agent 走哪算哪* |
| [s04](./s04-subagent.md) | 子智能体 | *大任务拆小, 每个小任务干净的上下文* |
| [s05](./s05-skill-loading.md) | Skills | *用到什么知识, 临时加载什么知识* |
| [s06](./s06-context-compact.md) | Context Compact | *上下文总会满, 要有办法腾地方* |
| [s07](./s07-task-system.md) | 任务系统 | *大目标要拆成小任务, 排好序, 记在磁盘上* |
| [s08](./s08-background-tasks.md) | 后台任务 | *慢操作丢后台, agent 继续想下一步* |
| [s09](./s09-agent-teams.md) | 智能体团队 | *任务太大一个人干不完, 要能分给队友* |
| [s10](./s10-team-protocols.md) | 团队协议 | *队友之间要有统一的沟通规矩* |
| [s11](./s11-autonomous-agents.md) | 自治智能体 | *队友自己看看板, 有活就认领* |
| [s12](./s12-worktree-task-isolation.md) | Worktree + 任务隔离 | *各干各的目录, 互不干扰* |

## 学完之后 -- 从理解到落地

12 个课程走完, 你已经从内到外理解了 agent 的工作原理。

## 许可证

MIT

---

**模型就是智能体。我们的工作就是给它工具, 然后让开。**