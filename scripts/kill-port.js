#!/usr/bin/env node

/**
 * Kill any process using the specified port, then exit cleanly.
 * Usage: node scripts/kill-port.js 3456
 */

import { execSync } from 'node:child_process';

const port = parseInt(process.argv[2], 10);
if (!port || port < 1 || port > 65535) {
  console.error('Usage: node scripts/kill-port.js <port>');
  process.exit(1);
}

const platform = process.platform;

try {
  if (platform === 'win32') {
    // Find PIDs listening on the port
    const output = execSync(
      `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (output) {
      const pids = new Set();
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== 0) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
          console.log(`Killed PID ${pid} on port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
      // Brief pause to let the port release
      execSync('timeout /t 1 /nobreak >nul 2>&1', { timeout: 3000 });
    }
  } else {
    // macOS / Linux
    const output = execSync(
      `lsof -ti :${port}`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (output) {
      const pids = output.split('\n').map(p => p.trim()).filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { timeout: 3000 });
          console.log(`Killed PID ${pid} on port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
      execSync('sleep 1', { timeout: 3000 });
    }
  }
} catch (e) {
  // No process on port — that's fine
  if (!e.message.includes('not found') && !e.stderr?.includes('not found')) {
    // Silently continue
  }
}

// Always exit 0 so the next command runs
process.exit(0);
