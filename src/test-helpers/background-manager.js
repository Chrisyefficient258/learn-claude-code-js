// test-helpers/background-manager.js
export default class BackgroundManager {
  constructor() {
    this.tasks = {};
    this.notificationQueue = [];
  }

  run(command) {
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
    if (dangerous.some(d => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    const taskId = Math.random().toString(36).slice(2, 10);
    this.tasks[taskId] = { status: 'running', result: null, command };
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId = null) {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || '(running)'}`;
    }
    const lines = Object.entries(this.tasks).map(([tid, t]) => `${tid}: [${t.status}] ${t.command.slice(0, 60)}`);
    return lines.length ? lines.join('\n') : 'No background tasks.';
  }

  drainNotifications() {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}
