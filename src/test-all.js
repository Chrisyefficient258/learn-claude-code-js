#!/usr/bin/env node
/**
 * test-all.js - Quick tests for all agent modules
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

const TEST_DIR = resolve(process.cwd(), '.test-temp');

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  writeFileSync('.env', 'MODEL_ID=claude-sonnet-4-6\nANTHROPIC_API_KEY=test-key\n');
}

function cleanup() {
  process.chdir('..');
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    return false;
  }
}

console.log('Testing agent modules...\n');
setup();

let passed = 0;
let total = 0;

// Test s01 - Basic structure
total++;
passed += test('s01: Has bash tool', () => {
  const content = execSync('grep -c "name: .bash" ../s01_agent_loop.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No bash tool found');
});

// Test s02 - Multiple tools
total++;
passed += test('s02: Has 4 tools', () => {
  const content = execSync('grep -c "name:" ../s02_tool_use.js', { encoding: 'utf8' });
  if (parseInt(content) < 4) throw new Error('Expected 4 tools');
});

// Test s03 - TodoManager
total++;
passed += test('s03: Has TodoManager class', () => {
  const content = execSync('grep -c "class TodoManager" ../s03_todo_write.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No TodoManager class');
});

// Test s04 - Subagent
total++;
passed += test('s04: Has runSubagent function', () => {
  const content = execSync('grep -c "async function runSubagent" ../s04_subagent.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No runSubagent function');
});

// Test s05 - SkillLoader
total++;
passed += test('s05: Has SkillLoader class', () => {
  const content = execSync('grep -c "class SkillLoader" ../s05_skill_loading.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No SkillLoader class');
});

// Test s06 - Compression
total++;
passed += test('s06: Has microCompact function', () => {
  const content = execSync('grep -c "function microCompact" ../s06_context_compact.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No microCompact function');
});

// Test s07 - TaskManager
total++;
passed += test('s07: Has TaskManager class', () => {
  const content = execSync('grep -c "class TaskManager" ../s07_task_system.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No TaskManager class');
});

// Test s08 - BackgroundManager
total++;
passed += test('s08: Has BackgroundManager class', () => {
  const content = execSync('grep -c "class BackgroundManager" ../s08_background_tasks.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No BackgroundManager class');
});

// Test s09 - MessageBus
total++;
passed += test('s09: Has MessageBus class', () => {
  const content = execSync('grep -c "class MessageBus" ../s09_agent_teams.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No MessageBus class');
});

// Test s10 - Protocols
total++;
passed += test('s10: Has shutdown protocol', () => {
  const content = execSync('grep -c "shutdown_request" ../s10_team_protocols.js', { encoding: 'utf8' });
  if (parseInt(content) < 3) throw new Error('No shutdown protocol');
});

// Test s11 - Autonomous
total++;
passed += test('s11: Has scanUnclaimedTasks', () => {
  const content = execSync('grep -c "function scanUnclaimedTasks" ../s11_autonomous_agents.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No scanUnclaimedTasks function');
});

// Test s12 - WorktreeManager
total++;
passed += test('s12: Has WorktreeManager class', () => {
  const content = execSync('grep -c "class WorktreeManager" ../s12_worktree_task_isolation.js', { encoding: 'utf8' });
  if (parseInt(content) < 1) throw new Error('No WorktreeManager class');
});

cleanup();

console.log(`\n${passed}/${total} tests passed`);
process.exit(passed === total ? 0 : 1);
