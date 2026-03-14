#!/usr/bin/env node
/**
 * test-unit.js - Unit tests for core functions
 */

import { strict as assert } from 'assert';

console.log('Running unit tests...\n');

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
  }
}

// Test TodoManager
test('TodoManager: validates items', async () => {
  const { default: TodoManager } = await import('./test-helpers/todo-manager.js');
  const todo = new TodoManager();
  const result = todo.update([
    { id: '1', text: 'Task 1', status: 'pending' },
    { id: '2', text: 'Task 2', status: 'in_progress' }
  ]);
  assert(result.includes('Task 1'));
  assert(result.includes('1/2 completed'));
});

test('TodoManager: rejects multiple in_progress', async () => {
  const { default: TodoManager } = await import('./test-helpers/todo-manager.js');
  const todo = new TodoManager();
  try {
    todo.update([
      { id: '1', text: 'Task 1', status: 'in_progress' },
      { id: '2', text: 'Task 2', status: 'in_progress' }
    ]);
    throw new Error('Should have thrown');
  } catch (e) {
    assert(e.message.includes('Only one task'));
  }
});

// Test BackgroundManager
test('BackgroundManager: creates task', async () => {
  const { default: BackgroundManager } = await import('./test-helpers/background-manager.js');
  const bg = new BackgroundManager();
  const result = bg.run('echo test');
  assert(result.includes('Background task'));
  assert(result.includes('started'));
});

test('BackgroundManager: blocks dangerous commands', async () => {
  const { default: BackgroundManager } = await import('./test-helpers/background-manager.js');
  const bg = new BackgroundManager();
  const result = bg.run('rm -rf /');
  assert(result.includes('Dangerous command blocked'));
});

console.log(`\n${passed}/${total} tests passed`);
process.exit(passed === total ? 0 : 1);
