/* ================================================
   SMARTGRID — script.js
   Simulated IoT data engine + UI updater
   ================================================ */

// ─── CONFIGURATION ──────────────────────────────
// Change these thresholds easily when you connect
// real sensors from ESP32 / database later.
const CONFIG = {
  updateInterval: 2000,      // milliseconds between updates
  tempLow: 22,               // below this: A/C turns OFF (too cold)
  tempHigh: 24,              // above this: A/C turns ON
  lightThreshold: 500,       // higher than this: lights turn ON (lux)
  historyLength: 10,         // how many past readings to show in chart
};

// ─── ROOM STATE ──────────────────────────────────
// Each room has a "base" value and a slow drift.
// This makes the simulation feel realistic, not random.
const rooms = [
  {
    id: 1,
    name: "Room 1",
    temp: 24.5,       // starting temperature (°C)
    light: 480,       // starting light intensity (lux)
    tempDrift: 0.1,   // how fast temp wanders per tick
    lightDrift: 15,   // how fast light wanders per tick
    tempHistory: [],  // stores last N temperature readings for the chart
  },
  {
    id: 2,
    name: "Room 2",
    temp: 26.2,
    light: 620,
    tempDrift: 0.15,
    lightDrift: 20,
    tempHistory: [],
  },
  {
    id: 3,
    name: "Room 3",
    temp: 22.8,
    light: 390,
    tempDrift: 0.08,
    lightDrift: 12,
    tempHistory: [],
  },
];

// ─── ALERT QUEUE ────────────────────────────────
// We'll collect alerts each cycle and display them.
let alertQueue = [];


// ═══════════════════════════════════════════════
// 1. SIMULATE NEW DATA
//    Makes values drift smoothly like real sensors.
// ═══════════════════════════════════════════════
function simulateRoom(room) {
  // Random small change, positive or negative (Gaussian-ish via sum)
  const tempChange  = (Math.random() - 0.5) * 2 * room.tempDrift;
  const lightChange = (Math.random() - 0.5) * 2 * room.lightDrift;

  // Apply drift, clamp to realistic ranges
  room.temp  = clamp(room.temp  + tempChange,  18, 35);
  room.light = clamp(room.light + lightChange,  50, 1000);

  // Save temperature to history for chart
  room.tempHistory.push(parseFloat(room.temp.toFixed(1)));
  if (room.tempHistory.length > CONFIG.historyLength) {
    room.tempHistory.shift(); // remove oldest reading
  }
}


// ═══════════════════════════════════════════════
// 2. CONTROL LOGIC
//    Decides A/C level and light state from sensor data.
// ═══════════════════════════════════════════════
function getACLevel(temp) {
  // Rule: if temp >= 24°C, A/C is ON (higher temp = higher level)
  if (temp < CONFIG.tempHigh) return 0; // OFF
  if (temp < 27)              return 1; // Mild cooling
  if (temp < 30)              return 2; // Medium cooling
  return 3;                             // Max cooling
}

function getLightState(lux) {
  // Rule: if lux < 500, lights turn ON
  return lux > CONFIG.lightThreshold;
}


// ═══════════════════════════════════════════════
// 3. STATUS LOGIC
//    Determines colour indicator (green/yellow/red).
// ═══════════════════════════════════════════════
function getRoomStatus(temp, lux) {
  // Critical: extreme temperature or very dark
  if (temp >= 32 || temp <= 18 || lux < 100) return "critical";
  // Warning: borderline conditions
  if (temp >= 29 || temp <= 20 || lux < 250) return "warning";
  // Normal otherwise
  return "normal";
}


// ═══════════════════════════════════════════════
// 4. UPDATE THE DOM (HTML elements)
//    This is where simulated data becomes visible.
// ═══════════════════════════════════════════════
function updateRoomUI(room) {
  const { id, temp, light, tempHistory } = room;
  const acLevel   = getACLevel(temp);
  const lightOn   = getLightState(light);
  const status    = getRoomStatus(temp, light);

  // ---- Temperature ----
  const tempEl = document.getElementById(`temp-val-${id}`);
  tempEl.textContent = temp.toFixed(1);
  // Colour-code the big temp number
  if (temp >= 30)      { tempEl.style.color = '#ff5252'; tempEl.style.textShadow = '0 0 14px rgba(255,82,82,0.5)'; }
  else if (temp >= 24) { tempEl.style.color = '#ffab40'; tempEl.style.textShadow = '0 0 14px rgba(255,171,64,0.4)'; }
  else                 { tempEl.style.color = '#40c4ff'; tempEl.style.textShadow = '0 0 14px rgba(64,196,255,0.4)'; }

  // ---- Light ----
  document.getElementById(`light-val-${id}`).textContent   = Math.round(light);
  const lightSubEl = document.getElementById(`light-status-${id}`);
  lightSubEl.textContent  = lightOn ? "ON" : "OFF";
  lightSubEl.style.color  = lightOn ? "#ffea00" : "#00e676";

  // ---- A/C ----
  const acVal = document.getElementById(`ac-val-${id}`);
  const acSub = document.getElementById(`ac-status-${id}`);
  if (acLevel === 0) {
    acVal.textContent     = "OFF";
    acVal.style.color     = "#5a7a90";
    acSub.textContent     = "Idle";
    acSub.style.color     = "#5a7a90";
  } else {
    acVal.textContent     = `LV ${acLevel}`;
    acVal.style.color     = "#00d4ff";
    acSub.textContent     = ["", "Mild", "Medium", "Max"][acLevel];
    acSub.style.color     = ["", "#80deea", "#29b6f6", "#0091ea"][acLevel];
  }

  // ---- Status badge & dot ----
  const badge      = document.getElementById(`badge-${id}`);
  const dot        = document.getElementById(`dot-${id}`);
  const statusText = document.getElementById(`status-text-${id}`);

  // Remove old classes, apply new
  badge.className = `card-status-badge ${status === "normal" ? "" : status}`;
  dot.className   = `status-dot ${status === "normal" ? "" : status}`;

  const statusLabels = {
    normal:   `All parameters nominal`,
    warning:  `⚠ Check conditions — temp ${temp.toFixed(1)}°C / lux ${Math.round(light)}`,
    critical: `✖ ALERT — Immediate attention required`,
  };
  badge.textContent      = status.toUpperCase();
  statusText.textContent = statusLabels[status];

  // ---- Draw the sparkline chart ----
  drawSparkline(id, tempHistory, status);

  // ---- Collect alerts ----
  if (status === "critical") {
    alertQueue.push(`Room ${id}: CRITICAL — T:${temp.toFixed(1)}°C / LUX:${Math.round(light)}`);
  } else if (status === "warning") {
    alertQueue.push(`Room ${id}: Warning — T:${temp.toFixed(1)}°C / LUX:${Math.round(light)}`);
  }
}


// ═══════════════════════════════════════════════
// 5. SPARKLINE CHART
//    Draws a tiny line graph on each room's <canvas>.
// ═══════════════════════════════════════════════
function drawSparkline(roomId, history, status) {
  const canvas = document.getElementById(`chart-${roomId}`);
  if (!canvas) return;
  const ctx    = canvas.getContext("2d");
  const W      = canvas.width;
  const H      = canvas.height;
  const pad    = 4; // inner padding

  ctx.clearRect(0, 0, W, H);

  if (history.length < 2) return; // not enough data yet

  const min = Math.min(...history) - 1;
  const max = Math.max(...history) + 1;

  // Map temperature value → Y pixel
  const toY = (v) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
  // Map index → X pixel
  const toX = (i) => pad + (i / (history.length - 1)) * (W - pad * 2);

  // Choose line colour based on status
  const lineColor = { normal: "#00d4ff", warning: "#ffea00", critical: "#ff1744" }[status];

  // Draw faint grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth   = 1;
  for (let g = 0; g <= 3; g++) {
    const gy = pad + (g / 3) * (H - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
  }

  // Draw the filled area under the line
  ctx.beginPath();
  ctx.moveTo(toX(0), H);
  history.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(history.length - 1), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, lineColor + "40"); // semi-transparent top
  grad.addColorStop(1, lineColor + "00"); // transparent bottom
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw the line itself
  ctx.beginPath();
  history.forEach((v, i) => {
    if (i === 0) ctx.moveTo(toX(i), toY(v));
    else         ctx.lineTo(toX(i), toY(v));
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 1.8;
  ctx.lineJoin    = "round";
  ctx.stroke();

  // Draw a dot at the latest value
  const lastX = toX(history.length - 1);
  const lastY = toY(history[history.length - 1]);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();

  // Label min/max on the right
  ctx.fillStyle = "rgba(90,122,144,0.8)";
  ctx.font      = "9px 'Share Tech Mono', monospace";
  ctx.fillText(`${max.toFixed(0)}°`, W - 22, pad + 8);
  ctx.fillText(`${min.toFixed(0)}°`, W - 22, H - pad - 2);
}


// ═══════════════════════════════════════════════
// 6. CLOCK
// ═══════════════════════════════════════════════
function updateClock() {
  const now  = new Date();
  const h    = String(now.getHours()).padStart(2, "0");
  const m    = String(now.getMinutes()).padStart(2, "0");
  const s    = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("clock").textContent = `${h}:${m}:${s}`;
}


// ═══════════════════════════════════════════════
// 7. ALERT BAR
// ═══════════════════════════════════════════════
function updateAlertBar() {
  const el = document.getElementById("alertText");
  if (alertQueue.length === 0) {
    el.textContent = "All systems nominal — No active alerts";
    el.style.color = "#5a7a90";
  } else {
    el.textContent = alertQueue.join("   ◆   ");
    el.style.color = alertQueue.some(a => a.includes("CRITICAL")) ? "#ff1744" : "#ffea00";
  }
  alertQueue = []; // reset after displaying
}


// ═══════════════════════════════════════════════
// 8. MAIN LOOP
//    Called every 2 seconds — simulate then update.
// ═══════════════════════════════════════════════
function mainLoop() {
  alertQueue = [];

  // Update each room
  rooms.forEach((room) => {
    simulateRoom(room);   // step 1: generate new data
    updateRoomUI(room);   // step 2: push data to HTML
  });

  updateAlertBar();       // step 3: update alert ticker
  updateClock();          // step 4: update clock
}


// ─── UTILITY: clamp a number between min and max ───
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}


// ─── START ───────────────────────────────────────
// Run once immediately, then repeat every 2 seconds.
updateClock();
mainLoop();
setInterval(mainLoop,  CONFIG.updateInterval);
setInterval(updateClock, 1000); // clock updates every second
