 /*============================================================
   SMARTGRID — script.js
   Full dashboard script: data layer + UI updater combined.
 
   ARCHITECTURE:
   ┌─────────────────────────────────────────────────┐
   │  1. CONFIG          — thresholds & settings      │
   │  2. ROOM REGISTRY   — per-room state storage     │
   │  3. SIMULATION      — fake sensor data engine    │
   │  4. getSensorData() — single data entry point    │
   │  5. CONTROL LOGIC   — AC / light / status rules  │
   │  6. STATE UPDATE    — history buffer + snapshot  │
   │  7. UI LAYER        — writes data to HTML        │
   │  8. CHART           — canvas sparkline drawing   │
   │  9. CLOCK & ALERTS  — header updates             │
   │ 10. LOOP            — drives everything          │
   └─────────────────────────────────────────────────┘
   ============================================================ */
 
 
/* ============================================================
   SECTION 1 — CONFIGURATION
   All thresholds in one place. Easy to change later.
   ============================================================ */
const CONFIG = {
  updateIntervalMs:  2000,   // how often everything updates (ms)
  historyLength:     10,     // temperature readings kept per room
  tempThresholdAC:   24.0,   // °C — at or above this, A/C turns ON
  luxThresholdLight: 500,    // lux — below this, lights turn ON
 
  // Simulation drift limits
  sim: {
    tempDriftMax: 0.3,       // max °C change per tick
    luxDriftMax:  25,        // max lux change per tick
    tempMin: 18, tempMax: 36,
    luxMin:  50, luxMax:  1000,
  },
};
 
 
/* ============================================================
   SECTION 2 — ROOM REGISTRY (State Storage Layer)
   Each room has its own isolated state — no shared variables.
   To add a new room: copy one entry and change id/label/_sim_*.
   ============================================================ */
const ROOM_REGISTRY = {
  1: {
    id:          1,
    label:       "Room 1",
    _sim_temp:   24.5,   // simulation starting temperature
    _sim_lux:    480,    // simulation starting lux
    tempHistory: [],     // last N readings — used by sparkline chart
    luxHistory:  [],
    latest:      null,   // most recent full snapshot — UI reads this
  },
  2: {
    id:          2,
    label:       "Room 2",
    _sim_temp:   26.2,
    _sim_lux:    620,
    tempHistory: [],
    luxHistory:  [],
    latest:      null,
  },
  3: {
    id:          3,
    label:       "Room 3",
    _sim_temp:   22.8,
    _sim_lux:    390,
    tempHistory: [],
    luxHistory:  [],
    latest:      null,
  },
};
 
 
/* ============================================================
   SECTION 3 — SIMULATION ENGINE
   Produces smooth, realistic fake sensor readings.
   Uses gaussian-ish drift so values don't jump randomly.
 
   >>>REPLACE<<< this whole section when connecting real hardware.
   ============================================================ */
 
/** Advances simulated physics for one room by one tick. */
function _sim_advancePhysics(room) {
  const cfg = CONFIG.sim;
 
  // Average of two randoms = bell-curve-like distribution
  const tempDelta = ((Math.random() + Math.random()) / 2 - 0.5) * 2 * cfg.tempDriftMax;
  const luxDelta  = ((Math.random() + Math.random()) / 2 - 0.5) * 2 * cfg.luxDriftMax;
 
  room._sim_temp = _clamp(room._sim_temp + tempDelta, cfg.tempMin, cfg.tempMax);
  room._sim_lux  = _clamp(room._sim_lux  + luxDelta,  cfg.luxMin,  cfg.luxMax);
}
 
/**
 * Returns a raw simulated reading for one room.
 * Shape matches what a real sensor/API should also return:
 *   { roomId, temperature, lux, timestamp }
 */
function _sim_getRawReading(roomId) {
  const room = ROOM_REGISTRY[roomId];
  _sim_advancePhysics(room);
  return {
    roomId:      room.id,
    temperature: parseFloat(room._sim_temp.toFixed(2)),
    lux:         parseFloat(room._sim_lux.toFixed(1)),
    timestamp:   Date.now(),
  };
}
 
 
/* ============================================================
   SECTION 4 — DATA ACCESS (Single Entry Point)
   getSensorData() is the ONLY function that touches raw data.
 
   >>>REPLACE<<< the one line inside to switch data source:
 
   ESP32 via MQTT:
     return mqttClient.getLatestReading(roomId);
 
   REST API (Node-RED / backend):
     const res = await fetch(`/api/rooms/${roomId}/latest`);
     return await res.json();
 
   Firebase:
     const snap = await db.ref(`rooms/${roomId}/latest`).get();
     return snap.val();
 
   Returned object must always have:
     { roomId, temperature, lux, timestamp }
   ============================================================ */
function getSensorData(roomId) {
  // >>>REPLACE<<< this line with your real data source
  return _sim_getRawReading(roomId);
}
 
 
/* ============================================================
   SECTION 5 — CONTROL LOGIC
   Pure functions: take a value, return a decision.
   No side effects — easy to test or modify independently.
   ============================================================ */
 
/** Returns true if A/C should be ON. */
function deriveACState(temp) {
  return temp >= CONFIG.tempThresholdAC;
}
 
/** Returns true if lights should be ON. */
function deriveLightState(lux) {
  return lux < CONFIG.luxThresholdLight;
}
 
/** Returns "normal", "warning", or "critical". */
function deriveRoomStatus(temp, lux) {
  if (temp >= 32 || temp <= 18 || lux < 100) return "critical";
  if (temp >= 29 || temp <= 20 || lux < 250) return "warning";
  return "normal";
}
 
 
/* ============================================================
   SECTION 6 — STATE UPDATE (History Buffer Layer)
   Fetches data, applies logic, updates history, stores snapshot.
   Only this function writes to ROOM_REGISTRY.
   ============================================================ */
 
/** Fetches and processes one room — updates room.latest */
function updateRoomState(roomId) {
  const room    = ROOM_REGISTRY[roomId];
  const reading = getSensorData(roomId);       // get raw data
 
  const acOn    = deriveACState(reading.temperature);
  const lightOn = deriveLightState(reading.lux);
  const status  = deriveRoomStatus(reading.temperature, reading.lux);
 
  // Push to rolling history buffers
  _pushHistory(room.tempHistory, reading.temperature);
  _pushHistory(room.luxHistory,  reading.lux);
 
  // Store full snapshot — UI reads only from here
  room.latest = {
    roomId:      roomId,
    label:       room.label,
    temperature: reading.temperature,
    lux:         reading.lux,
    acOn:        acOn,               // true / false
    lightOn:     lightOn,            // true / false
    status:      status,             // "normal" | "warning" | "critical"
    tempHistory: [...room.tempHistory],
    luxHistory:  [...room.luxHistory],
    timestamp:   reading.timestamp,
  };
}
 
/** Returns the latest snapshot for one room. */
function getRoomSnapshot(roomId) {
  return ROOM_REGISTRY[roomId]?.latest ?? null;
}
 
/** Returns all room snapshots as an array. */
function getAllSnapshots() {
  return Object.keys(ROOM_REGISTRY).map(id => getRoomSnapshot(Number(id)));
}
 
 
/* ============================================================
   SECTION 7 — UI LAYER
   Reads from room.latest and writes to HTML elements.
   This is the only section that touches the DOM.
   ============================================================ */
 
/** Updates all HTML elements for one room from its snapshot. */
function updateRoomUI(snap) {
  if (!snap) return;
  const { roomId, temperature, lux, acOn, lightOn, status, tempHistory } = snap;
 
  // ---- Temperature (big number, colour-coded) ----
  const tempEl = document.getElementById(`temp-val-${roomId}`);
  if (tempEl) {
    tempEl.textContent = temperature.toFixed(1);
    if (temperature >= 30) {
      tempEl.style.color      = "#ff5252";
      tempEl.style.textShadow = "0 0 14px rgba(255,82,82,0.5)";
    } else if (temperature >= 24) {
      tempEl.style.color      = "#ffab40";
      tempEl.style.textShadow = "0 0 14px rgba(255,171,64,0.4)";
    } else {
      tempEl.style.color      = "#40c4ff";
      tempEl.style.textShadow = "0 0 14px rgba(64,196,255,0.4)";
    }
  }
 
  // ---- Light intensity + ON/OFF state ----
  const lightValEl = document.getElementById(`light-val-${roomId}`);
  const lightSubEl = document.getElementById(`light-status-${roomId}`);
  if (lightValEl) lightValEl.textContent = Math.round(lux);
  if (lightSubEl) {
    lightSubEl.textContent = lightOn ? "ON" : "OFF";
    lightSubEl.style.color = lightOn ? "#ffea00" : "#00e676";
  }
 
  // ---- A/C ON / OFF ----
  const acValEl = document.getElementById(`ac-val-${roomId}`);
  const acSubEl = document.getElementById(`ac-status-${roomId}`);
  if (acValEl && acSubEl) {
    if (acOn) {
      acValEl.textContent = "ON";
      acValEl.style.color = "#00d4ff";
      acSubEl.textContent = "Cooling";
      acSubEl.style.color = "#00d4ff";
    } else {
      acValEl.textContent = "OFF";
      acValEl.style.color = "#5a7a90";
      acSubEl.textContent = "Idle";
      acSubEl.style.color = "#5a7a90";
    }
  }
 
  // ---- Status badge, dot, and text ----
  const badge      = document.getElementById(`badge-${roomId}`);
  const dot        = document.getElementById(`dot-${roomId}`);
  const statusText = document.getElementById(`status-text-${roomId}`);
 
  if (badge) {
    badge.className   = `card-status-badge ${status === "normal" ? "" : status}`;
    badge.textContent = status.toUpperCase();
  }
  if (dot) {
    dot.className = `status-dot ${status === "normal" ? "" : status}`;
  }
  if (statusText) {
    const messages = {
      normal:   "All parameters nominal",
      warning:  `⚠ Check conditions — ${temperature.toFixed(1)}°C / ${Math.round(lux)} lux`,
      critical: "✖ ALERT — Immediate attention required",
    };
    statusText.textContent = messages[status];
  }
 
  // ---- Sparkline chart ----
  drawSparkline(roomId, tempHistory, status);
}
 
 
/* ============================================================
   SECTION 8 — SPARKLINE CHART (Canvas API)
   Draws a mini temperature trend graph on each room card.
   ============================================================ */
function drawSparkline(roomId, history, status) {
  const canvas = document.getElementById(`chart-${roomId}`);
  if (!canvas || history.length < 2) return;
 
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const pad = 4;
 
  ctx.clearRect(0, 0, W, H);
 
  const min = Math.min(...history) - 1;
  const max = Math.max(...history) + 1;
 
  const toX = (i) => pad + (i / (history.length - 1)) * (W - pad * 2);
  const toY = (v) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
 
  const lineColor = { normal: "#00d4ff", warning: "#ffea00", critical: "#ff1744" }[status];
 
  // Faint grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const gy = pad + (g / 3) * (H - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
  }
 
  // Filled area under the line
  ctx.beginPath();
  ctx.moveTo(toX(0), H);
  history.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(history.length - 1), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, lineColor + "40");
  grad.addColorStop(1, lineColor + "00");
  ctx.fillStyle = grad;
  ctx.fill();
 
  // Line
  ctx.beginPath();
  history.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 1.8;
  ctx.lineJoin    = "round";
  ctx.stroke();
 
  // Dot at latest value
  const lx = toX(history.length - 1);
  const ly = toY(history[history.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
 
  // Min/max labels
  ctx.fillStyle = "rgba(90,122,144,0.8)";
  ctx.font      = "9px 'Share Tech Mono', monospace";
  ctx.fillText(`${max.toFixed(0)}°`, W - 22, pad + 8);
  ctx.fillText(`${min.toFixed(0)}°`, W - 22, H - pad - 2);
}
 
 
/* ============================================================
   SECTION 9 — CLOCK & ALERT BAR
   ============================================================ */
function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const el  = document.getElementById("clock");
  if (el) el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
 
function updateAlertBar(snapshots) {
  const el = document.getElementById("alertText");
  if (!el) return;
 
  const alerts = snapshots
    .filter(s => s && s.status !== "normal")
    .map(s => `Room ${s.roomId}: ${s.status.toUpperCase()} — ${s.temperature.toFixed(1)}°C / ${Math.round(s.lux)} lux`);
 
  if (alerts.length === 0) {
    el.textContent = "All systems nominal — No active alerts";
    el.style.color = "#5a7a90";
  } else {
    el.textContent = alerts.join("   ◆   ");
    el.style.color = alerts.some(a => a.includes("CRITICAL")) ? "#ff1744" : "#ffea00";
  }
}
 
 
/* ============================================================
   SECTION 10 — MAIN LOOP
   Ties everything together. Runs every 2 seconds.
   ============================================================ */
function runCycle() {
  // Step 1: update data state for all rooms
  Object.keys(ROOM_REGISTRY).forEach(id => updateRoomState(Number(id)));
 
  // Step 2: get all snapshots and push to UI
  const snapshots = getAllSnapshots();
  snapshots.forEach(snap => updateRoomUI(snap));
 
  // Step 3: update header elements
  updateAlertBar(snapshots);
}
 
// ---- START ----
updateClock();                                     // clock starts immediately
runCycle();                                        // first data cycle immediately
setInterval(runCycle,    CONFIG.updateIntervalMs); // repeats every 2s
setInterval(updateClock, 1000);                    // clock ticks every 1s
 
 
/* ============================================================
   UTILITIES
   ============================================================ */
 
/** Pushes value into a fixed-length rolling array. */
function _pushHistory(arr, val) {
  arr.push(val);
  if (arr.length > CONFIG.historyLength) arr.shift();
}
 
/** Clamps a number between min and max. */
function _clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}
 