# Agents JS

Node.js implementations of the Python agent patterns from the `agents/` directory.

## Setup

```bash
npm install
```

Make sure you have a `.env` file with:
```
ANTHROPIC_API_KEY=your_key_here
MODEL_ID=claude-sonnet-4-6
```

## Running

```bash
npm run s01  # Agent loop
npm run s02  # Tool use
npm run s03  # Todo tracking
npm run s04  # Subagents
npm run s05  # Skill loading
npm run s06  # Context compression
npm run s07  # Task system
npm run s08  # Background tasks
npm run s09  # Agent teams
npm run s10  # Team protocols
npm run s11  # Autonomous agents
npm run s12  # Worktree isolation
```

## Files

- `s01_agent_loop.js` - Basic agent loop with bash tool
- `s02_tool_use.js` - Multiple tools (bash, read, write, edit)
- `s03_todo_write.js` - Todo tracking with nag reminders
- `s04_subagent.js` - Spawning subagents with isolated context
- `s05_skill_loading.js` - Two-layer skill loading system
- `s06_context_compact.js` - Three-layer context compression
- `s07_task_system.js` - Persistent task board with dependencies
- `s08_background_tasks.js` - Background command execution
- `s09_agent_teams.js` - Multi-agent teams with message passing
- `s10_team_protocols.js` - Shutdown and plan approval protocols
- `s11_autonomous_agents.js` - Self-directed agents with task polling
- `s12_worktree_task_isolation.js` - Git worktree isolation for parallel work
