const express = require("express");
const multer = require("multer");
const fs = require("fs");
const login = require("josh-fca");

const app = express();
const port = 2007;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const RECOVERY_FILE = "recovery.json";
const DEVICE_FILE = "device.json";

const activeTasks = {};
const loggedInUsers = {};

const fixedClientID = "XmartyAyushKing";

function parseCookies(rawCookies) {
  const cookies = {};
  rawCookies.split(";").forEach((item) => {
    const [key, value] = item.trim().split("=");
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

function convertToAppState(cookies) {
  return Object.entries(cookies).map(([key, value]) => ({
    key,
    value,
    domain: "facebook.com",
    path: "/",
    secure: true,
    httpOnly: false,
  }));
}

function loadRecoveryData() {
  if (fs.existsSync(RECOVERY_FILE)) {
    try {
      const raw = fs.readFileSync(RECOVERY_FILE, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.users)) return data.users;
    } catch (e) {
      console.error("❌ Failed to parse recovery file:", e);
    }
  }
  return [];
}

function saveRecoveryData(users) {
  fs.writeFileSync(RECOVERY_FILE, JSON.stringify({ users }, null, 2));
}

function updateUserProgress(uid, data) {
  const all = loadRecoveryData();
  const index = all.findIndex((u) => u.uid === uid);
  if (index >= 0) {
    all[index] = { ...all[index], ...data };
  } else {
    all.push(data);
  }
  saveRecoveryData(all);
}

function saveDeviceInfo(api) {
  const fallbackUserAgent = "Dalvik/2.1.0 (Linux; U; Android 10; SM-A107F Build/QP1A.190711.020)";
  const device = {
    clientID: api.clientID || fixedClientID,
    mqttClientID: api.mqttClientID || null,
    userAgent: api.userAgent || api?.ctx?.userAgent || fallbackUserAgent,
    ctx: api.ctx || {},
  };

  try {
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2));
    console.log("✅ Device info saved:", device);
  } catch (err) {
    console.log("❌ Failed to save device info:", err);
  }
}

function loadDeviceInfo() {
  if (fs.existsSync(DEVICE_FILE)) {
    try {
      const device = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
      return {
        clientID: device.clientID || fixedClientID,
        mqttClientID: device.mqttClientID || null,
        ctx: device.ctx || {},
        userAgent: device.userAgent || "Dalvik/2.1.0 (Linux; U; Android 10; SM-A107F Build/QP1A.190711.020)",
      };
    } catch (e) {
      console.log("❌ Failed to load device info:", e);
    }
  }
  return {};
}

function getLoginOptions(appState, deviceInfo) {
  return {
    appState,
    clientID: deviceInfo?.clientID || fixedClientID,
    forceLogin: true,
    listenEvents: false,
    autoMarkDelivery: false,
    selfListen: false,
    updatePresence: false,
    logLevel: "silent",
    AutoReconnect: true,
    AutoRefresh: true,
    AutoRefreshFbDtsg: true,
    BypassLoginCaptcha: true,
    BypassAutomationBehavior: true,
    ctx: deviceInfo?.ctx || {},
    userAgent: deviceInfo?.userAgent || "Dalvik/2.1.0 (Linux; U; Android 10; SM-A107F Build/QP1A.190711.020)",
    mqttClientID: deviceInfo?.mqttClientID || null,
  };
}

app.post("/login-cookie", (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ success: false, error: "No cookies provided." });

  const parsedCookies = parseCookies(cookies);
  const appState = convertToAppState(parsedCookies);
  const deviceInfo = loadDeviceInfo();

  login(getLoginOptions(appState, deviceInfo), (err, api) => {
    if (err) return res.json({ success: false, error: "Login failed" });

    saveDeviceInfo(api);
    const uid = api.getCurrentUserID();
    loggedInUsers[uid] = { appState, currentIndex: 0 };
    res.json({ success: true, uid });
  });
});

app.post("/start", upload.single("messages"), (req, res) => {
  const { delay, hatersName, targetUid } = req.body;
  if (!req.file || !delay || !hatersName || !targetUid) {
    return res.status(400).send("❌ Missing required fields.");
  }

  const filePath = req.file.path;
  const rawMessages = fs.readFileSync(filePath, "utf8");
  const messages = rawMessages.split("\n").filter(Boolean);

  for (const [uid, data] of Object.entries(loggedInUsers)) {
    startProcess(data.appState, uid, messages, parseInt(delay), hatersName, targetUid, 1, data.currentIndex || 0);
  }

  res.send(`✅ Started message sending to ${targetUid} from ${Object.keys(loggedInUsers).length} IDs`);
});

function startProcess(appState, uid, messages, delay, hatersName, targetUid, attempt = 1, index = 0) {
  if (activeTasks[uid]) return;
  const deviceInfo = loadDeviceInfo();

  login(getLoginOptions(appState, deviceInfo), (err, api) => {
    if (err) {
      if (attempt < 2) {
        console.log(`[${uid}] Login failed. Retrying (${attempt + 1}/2)...`);
        return setTimeout(() => {
          startProcess(appState, uid, messages, delay, hatersName, targetUid, attempt + 1, index);
        }, 3000);
      } else {
        console.log(`[${uid}] ❌ Login failed twice. Removing...`);
        delete activeTasks[uid];
        delete loggedInUsers[uid];
        const updated = loadRecoveryData().filter((u) => u.uid !== uid);
        saveRecoveryData(updated);
        return;
      }
    }

    saveDeviceInfo(api);
    activeTasks[uid] = true;

    function sendLoop() {
      if (!activeTasks[uid]) return;

      const msg = `${hatersName} ${messages[index]}`;
      api.sendMessage(msg, targetUid, (err) => {
        if (err) {
          console.log(`[${uid}] ❌ Message failed:`, err);
          delete activeTasks[uid];
          delete loggedInUsers[uid];
          const updated = loadRecoveryData().filter((u) => u.uid !== uid);
          saveRecoveryData(updated);
          return;
        }

        console.log(`[${uid}] ✅ Sent to ${targetUid}: ${msg}`);
        index = (index + 1) % messages.length;
        loggedInUsers[uid].currentIndex = index;

        updateUserProgress(uid, {
          uid,
          cookies: appState.map((c) => `${c.key}=${c.value}`).join("; "),
          delay,
          hatersName,
          targetUid,
          messages,
          currentIndex: index,
        });

        setTimeout(sendLoop, delay * 1000);
      });
    }

    sendLoop();
  });
}

app.post("/stop", (req, res) => {
  const { uid } = req.body;
  if (activeTasks[uid]) {
    delete activeTasks[uid];
    const updated = loadRecoveryData().filter((u) => u.uid !== uid);
    saveRecoveryData(updated);
    res.send(`🛑 Stopped task for ID: ${uid}`);
  } else {
    res.send(`⚠️ No task found for ID: ${uid}`);
  }
});

async function resumeAllProcesses() {
  const users = loadRecoveryData();
  const deviceInfo = loadDeviceInfo();

  for (const u of users) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const parsedCookies = parseCookies(u.cookies);
    const appState = convertToAppState(parsedCookies);

    login(getLoginOptions(appState, deviceInfo), (err, api) => {
      if (err) {
        console.log(`[${u.uid}] First login failed. Retrying...`);
        return setTimeout(() => {
          login(getLoginOptions(appState, deviceInfo), (err2, api2) => {
            if (err2) {
              console.log(`[${u.uid}] Second login failed. Removing.`);
              delete loggedInUsers[u.uid];
              const updated = loadRecoveryData().filter((x) => x.uid !== u.uid);
              saveRecoveryData(updated);
            } else {
              saveDeviceInfo(api2);
              loggedInUsers[u.uid] = { appState, currentIndex: u.currentIndex || 0 };
              startProcess(appState, u.uid, u.messages, u.delay, u.hatersName, u.targetUid, 1, u.currentIndex);
            }
          });
        }, 3000);
      } else {
        saveDeviceInfo(api);
        loggedInUsers[u.uid] = { appState, currentIndex: u.currentIndex || 0 };
        startProcess(appState, u.uid, u.messages, u.delay, u.hatersName, u.targetUid, 1, u.currentIndex);
      }
    });
  }
}

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  resumeAllProcesses();
});