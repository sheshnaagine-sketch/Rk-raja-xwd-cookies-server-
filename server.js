const fs = require('fs');
const path = require('path');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

/* ================= GLOBAL STATE ================= */

const tasks = new Map(); // Map<taskId, task>
let startTime = Date.now();

const monitorData = {
  activeTasks: 0,
  totalSent: 0
};

/* ================= TASK CLASSES ================= */

class TaskConfig {
  constructor(delay, cookies) {
    this.delay = parseInt(delay) || 10;
    this.running = true;
    this.cookies = cookies;
  }
}

class TaskMessageData {
  constructor(threadID, messages, hatersName, lastName) {
    this.threadID = threadID;
    this.messages = messages;
    this.hatersName = hatersName;
    this.lastName = lastName;
    this.currentIndex = 0;
    this.loopCount = 0;
  }
}

/* ================= RAW SESSION MANAGER ================= */

class RawSessionManager {
  constructor(ws, taskId, totalSessions) {
    this.ws = ws;
    this.taskId = taskId;
    this.totalSessions = totalSessions;

    this.sessions = new Map();
    this.sessionQueue = [];

    this.unhealthyCount = 0;
    this.unhealthyThreshold = Math.max(1, Math.floor(totalSessions * 0.75));
  }

  log(msg) {
    const text = `[Task ${this.taskId}] ${msg}`;
    console.log(text);

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'log', message: text }));
    }
  }

  checkStopCondition() {
    if (this.unhealthyCount >= this.unhealthyThreshold) {
      this.log(`🛑 Too many unhealthy cookies (${this.unhealthyCount}/${this.totalSessions})`);
      setTimeout(() => stopTask(this.taskId, this.ws, 'Most cookies failed'), 0);
      return true;
    }
    return false;
  }

  async createRawSession(cookie, index, threadID) {
    return new Promise((resolve) => {
      this.log(`🔐 Creating session ${index + 1}`);

      wiegine.login(cookie, {
        logLevel: 'silent',
        forceLogin: true
      }, (err, api) => {
        if (err || !api) {
          this.unhealthyCount++;
          this.log(`❌ Session ${index + 1} failed`);
          this.checkStopCondition();
          return resolve(null);
        }

        api.getThreadInfo(threadID, (e) => {
          if (e) {
            this.unhealthyCount++;
            this.log(`⚠️ Session ${index + 1} no thread access`);
            this.checkStopCondition();
            return resolve(null);
          }

          this.sessions.set(index, { api, healthy: true });
          this.sessionQueue.push(index);
          this.log(`✅ Session ${index + 1} ready`);
          resolve(api);
        });
      });
    });
  }

  getHealthySessions() {
    const arr = [];
    for (const s of this.sessions.values()) {
      if (s.healthy) arr.push(s.api);
    }
    return arr;
  }
}

/* ================= MESSAGE SENDER ================= */

class RawMessageSender {
  constructor(manager) {
    this.manager = manager;
  }

  async send(api, msg, threadID) {
    return new Promise((resolve) => {
      api.sendMessage(msg, threadID, (err) => {
        if (err) {
          this.manager.log(`❌ Send failed`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async sendMessage(finalMsg, threadID) {
    const sessions = this.manager.getHealthySessions();
    if (sessions.length === 0) return false;

    for (const api of sessions) {
      if (await this.send(api, finalMsg, threadID)) {
        this.manager.log(`✅ Message sent`);
        return true;
      }
    }
    return false;
  }
}

/* ================= CORE TASK LOGIC ================= */

async function createRawSessions(task) {
  for (let i = 0; i < task.config.cookies.length; i++) {
    await task.rawManager.createRawSession(
      task.config.cookies[i],
      i,
      task.messageData.threadID
    );
  }
  return task.rawManager.getHealthySessions().length > 0;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function runTaskLoop(taskId) {
  const task = tasks.get(taskId);
  if (!task || !task.config.running) return;

  const { rawManager, rawSender, messageData } = task;

  if (messageData.currentIndex >= messageData.messages.length) {
    messageData.currentIndex = 0;
    messageData.loopCount++;
    rawManager.log(`🔁 Loop ${messageData.loopCount}`);
  }

  const finalMsg =
    `${randomFrom(messageData.hatersName)} ` +
    `${messageData.messages[messageData.currentIndex]} ` +
    `${randomFrom(messageData.lastName)}`;

  const ok = await rawSender.sendMessage(finalMsg, messageData.threadID);

  if (ok) {
    messageData.currentIndex++;
    monitorData.totalSent++;
  }
}

/* ================= TASK CONTROL ================= */

function startTask(ws, data) {
  const cookies = data.cookieContent.split('\n').map(l => l.trim()).filter(Boolean);
  const messages = data.messageContent.split('\n').map(l => l.trim()).filter(Boolean);

  const threadID = data.threadID.trim();
  const delay = parseInt(data.delay) || 10;

  const haters = data.hatersName.split(',').map(s => s.trim()).filter(Boolean);
  const lastNames = data.lastHereName.split(',').map(s => s.trim()).filter(Boolean);

  if (!/^\d+$/.test(threadID)) {
    return ws.send(JSON.stringify({ type: 'log', message: '❌ Invalid thread ID' }));
  }

  const taskId = uuidv4();

  const config = new TaskConfig(delay, cookies);
  const msgData = new TaskMessageData(threadID, messages, haters, lastNames);
  const manager = new RawSessionManager(ws, taskId, cookies.length);
  const sender = new RawMessageSender(manager);

  const task = {
    taskId,
    config,
    messageData: msgData,
    rawManager: manager,
    rawSender: sender,
    intervalId: null,
    ws
  };

  tasks.set(taskId, task);
  monitorData.activeTasks = tasks.size;

  manager.log(`🚀 Task started (${taskId})`);

  createRawSessions(task).then(ok => {
    if (!ok) return stopTask(taskId, ws, 'No healthy cookies');

    task.intervalId = setInterval(
      () => runTaskLoop(taskId),
      delay * 1000
    );

    ws.send(JSON.stringify({ type: 'task_started', taskId }));
  });
}

function stopTask(taskId, ws, reason = 'Stopped') {
  const task = tasks.get(taskId);
  if (!task) return;

  if (task.intervalId) clearInterval(task.intervalId);
  task.config.running = false;
  tasks.delete(taskId);
  monitorData.activeTasks = tasks.size;

  task.rawManager.log(`⏹ Task stopped: ${reason}`);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stopped', taskId, reason }));
  }
}

/* ================= EXPRESS ================= */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`🔥 Server running on http://localhost:${PORT}`);
});

/* ================= WEBSOCKET + KEEP ALIVE ================= */

const wss = new WebSocket.Server({ server, path: '/ws' });

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === 'start') startTask(ws, data);
    if (data.type === 'stop_by_id') stopTask(data.taskId, ws);
    if (data.type === 'monitor') {
      ws.send(JSON.stringify({
        type: 'monitor_data',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks: monitorData.activeTasks,
        totalSent: monitorData.totalSent
      }));
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

process.on('uncaughtException', err => {
  console.log('🛡 Error:', err.message);
});
