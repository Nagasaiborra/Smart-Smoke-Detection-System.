/* -------------------------------------------------------------
   CORE JAVASCRIPT LOGIC FOR 5G SMART SMOKE DETECTION GATEWAY
   ------------------------------------------------------------- */

// ==========================================
// 1. Central Coordinates & Configuration
// ==========================================
// Central WebSocket manager instance variable
let wsManager = null;

// Connection Uptime counters
let uptimeInterval = null;

// Alarm Siren Audio variables
let audioCtx = null;
let sirenInterval = null;

// Thresholds and alert configurations
let soundEnabled = localStorage.getItem('smoke_dashboard_sound') !== 'false';
let toastEnabled = localStorage.getItem('smoke_dashboard_toast') !== 'false';
let smokeWarningThreshold = parseInt(localStorage.getItem('smoke_dashboard_warn')) || 1500;
let smokeDangerThreshold = parseInt(localStorage.getItem('smoke_dashboard_danger')) || 2500;
let currentTheme = localStorage.getItem('smoke_dashboard_theme') || 'dark';

// Chart.js 4.x Object Instances
let smokeChart = null;
let tempChart = null;
let humChart = null;

// Real-Time packet states
let packetCounter = 0;
let consolePackets = []; // Keep last 100 packets in memory buffer for History page logs

// Cumulative statistics
let stats = {
  maxSmoke: 0,
  minSmoke: Infinity,
  totalTemp: 0,
  totalHum: 0,
  packetsCount: 0,
  safeCount: 0,
  warnCount: 0,
  dangerCount: 0
};

// Load saved stats cache
const storedStats = localStorage.getItem('smoke_dashboard_stats');
if (storedStats) {
  try {
    const parsed = JSON.parse(storedStats);
    if (parsed.minSmoke === null || parsed.minSmoke === 'Infinity') parsed.minSmoke = Infinity;
    stats = { ...stats, ...parsed };
  } catch (e) {
    console.error('Failed to load stats cache', e);
  }
}

// Track alarm state transitions
let lastStatus = null;

// ==========================================
// 2. Real-Time Telemetry Graph Module (Chart.js 4.x)
// ==========================================
function initRealTimeCharts() {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#131C2F',
        borderColor: '#2A3854',
        borderWidth: 1,
        titleColor: '#F5F7FA',
        bodyColor: '#A7B1C2',
        titleFont: { family: 'Inter', size: 9 },
        bodyFont: { family: 'Inter', size: 11, weight: 'bold' }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: '#A7B1C2', font: { size: 9, family: 'Inter', weight: 'bold' } }
      },
      y: {
        border: { display: false },
        grid: { color: 'rgba(42, 56, 84, 0.4)' },
        ticks: { color: '#A7B1C2', font: { size: 9, family: 'Inter', weight: 'bold' } }
      }
    }
  };

  // 1. Smoke Concentration Chart (Red line, filled, width 3, point radius 2)
  const ctxSmoke = document.getElementById('smokeChartCanvas');
  smokeChart = new Chart(ctxSmoke, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Smoke (PPM)',
        data: [],
        borderColor: '#FF4D4F',
        backgroundColor: 'rgba(255, 77, 79, 0.03)',
        borderWidth: 3,
        pointRadius: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          suggestedMin: 0,
          suggestedMax: 3000
        }
      }
    }
  });

  // 2. Temperature Chart (Orange line, filled, width 3, point radius 2)
  const ctxTemp = document.getElementById('tempChartCanvas');
  tempChart = new Chart(ctxTemp, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Temperature (°C)',
        data: [],
        borderColor: '#FFB020',
        backgroundColor: 'rgba(255, 176, 32, 0.03)',
        borderWidth: 3,
        pointRadius: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          suggestedMin: 15,
          suggestedMax: 45
        }
      }
    }
  });

  // 3. Humidity Chart (Blue line, filled, width 3, point radius 2)
  const ctxHum = document.getElementById('humChartCanvas');
  humChart = new Chart(ctxHum, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Humidity (%RH)',
        data: [],
        borderColor: '#3BA4FF',
        backgroundColor: 'rgba(59, 164, 255, 0.03)',
        borderWidth: 3,
        pointRadius: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        y: {
          ...commonOptions.scales.y,
          min: 0,
          max: 100
        }
      }
    }
  });
}

function hideOfflineOverlays() {
  document.getElementById('smoke-offline-overlay').classList.add('hidden');
  document.getElementById('temp-offline-overlay').classList.add('hidden');
  document.getElementById('hum-offline-overlay').classList.add('hidden');
}

function showOfflineOverlays() {
  document.getElementById('smoke-offline-overlay').classList.remove('hidden');
  document.getElementById('temp-offline-overlay').classList.remove('hidden');
  document.getElementById('hum-offline-overlay').classList.remove('hidden');
}

// ==========================================
// 3. Packet Parser & Telemetry Handlers
// ==========================================
function handleIncomingPacket(message) {
  if (!message || typeof message !== 'string') return;

  const parts = message.split(',');

  // Check header signature and length
  if (parts[0] !== 'DATA' || parts.length < 5) {
    console.warn('Ignoring invalid packet (incorrect header):', message);
    return;
  }

  const statusStr = parts[1].trim().toUpperCase();
  const smoke = parseInt(parts[2], 10);
  const temperature = parseFloat(parts[3]);
  const humidity = parseFloat(parts[4]);

  if (isNaN(smoke) || isNaN(temperature) || isNaN(humidity)) {
    console.warn('Ignoring packet containing non-numeric values:', message);
    return;
  }

  // Print to console on every packet as requested
  console.log("Packet received");
  console.log(smoke);
  console.log(temperature);
  console.log(humidity);

  packetCounter++;

  // Set local Timestamp
  const timestamp = Date.now();
  const dateObj = new Date(timestamp);
  const formattedTime = dateObj.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  const parsedData = {
    packetNo: packetCounter,
    timestamp: formattedTime,
    status: statusStr,
    smoke: smoke,
    temp: temperature,
    humidity: humidity
  };
  // Log parsed data values as requested
  console.log({
    status: statusStr,
    smoke: smoke,
    temperature: temperature,
    humidity: humidity
  });

  // Keep latest 100 packets in memory buffer
  consolePackets.push(parsedData);
  if (consolePackets.length > 100) {
    consolePackets.shift();
  }

  // 1. Push points & timestamps immediately to graphs
  smokeChart.data.labels.push(formattedTime);
  smokeChart.data.datasets[0].data.push(smoke);

  tempChart.data.labels.push(formattedTime);
  tempChart.data.datasets[0].data.push(temperature);

  humChart.data.labels.push(formattedTime);
  humChart.data.datasets[0].data.push(humidity);

  // 2. Maintain latest 100 samples window (scroll left)
  if (smokeChart.data.labels.length > 100) {
    smokeChart.data.labels.shift();
    smokeChart.data.datasets[0].data.shift();
  }
  if (tempChart.data.labels.length > 100) {
    tempChart.data.labels.shift();
    tempChart.data.datasets[0].data.shift();
  }
  if (humChart.data.labels.length > 100) {
    humChart.data.labels.shift();
    humChart.data.datasets[0].data.shift();
  }

  // 3. Redraw smoothly using chart.update('none') to prevent lag
  smokeChart.update('none');
  tempChart.update('none');
  humChart.update('none');

  // Verify that every graph plots values correctly by logging values array
  console.log("Smoke data array:", smokeChart.data.datasets[0].data);

  // 4. Hide overlays on packet arrival by directly checking DOM status
  const overlay = document.getElementById('smoke-offline-overlay');
  if (overlay && !overlay.classList.contains('hidden')) {
    hideOfflineOverlays();
  }

  // Log execution path trace before updating each gauge
  console.log("updateSmokeGauge()", smoke);
  updateSmoke(smoke);

  console.log("updateTemperatureGauge()", temperature);
  updateTemperature(temperature);

  console.log("updateHumidityGauge()", humidity);
  updateHumidity(humidity);

  // Log DOM status immediately after DOM replacement
  console.log("DOM Temperature =", document.getElementById('temp-value'));
  console.log("DOM Humidity =", document.getElementById('hum-value'));

  updateStatus(statusStr);

  updateStats(parsedData);
  appendDashboardEventRow(parsedData);

  // Handle status audio alerts and transitions
  evaluateStatusAlerts(statusStr);
}

// -------------------------------------------------------------
// Direct Gauge Redrawing Functions
// -------------------------------------------------------------
function updateSmoke(smoke) {
  // Update numeric labels and unit text
  document.getElementById('smoke-value').innerText = smoke;
  
  const smokePct = Math.min(Math.max((smoke / 5000) * 100, 0), 100);
  document.getElementById('smoke-progress-fill').style.width = `${smokePct}%`;
  
  // Recalculate progress arc from latest value
  const smokeOffset = 125.66 - (125.66 * smokePct) / 100;
  document.getElementById('smoke-gauge-path').setAttribute('stroke-dashoffset', smokeOffset);

  // Smoke Trend Arrow (Replaces parent element HTML dynamically to prevent Lucide query errors)
  const trendBadge = document.getElementById('smoke-trend-badge');
  let prevSmoke = consolePackets.length > 1 ? consolePackets[consolePackets.length - 2].smoke : null;
  if (prevSmoke !== null) {
    const iconName = smoke > prevSmoke ? 'trending-up' : (smoke < prevSmoke ? 'trending-down' : 'minus');
    const color = smoke > prevSmoke ? 'var(--accent-rose)' : (smoke < prevSmoke ? 'var(--accent-emerald)' : 'var(--text-muted)');
    const bg = smoke > prevSmoke ? 'rgba(244, 63, 94, 0.08)' : (smoke < prevSmoke ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)');
    const label = smoke > prevSmoke ? 'Increasing' : (smoke < prevSmoke ? 'Decreasing' : 'Stable');

    trendBadge.style.color = color;
    trendBadge.style.backgroundColor = bg;
    trendBadge.innerHTML = `<i data-lucide="${iconName}" size="12"></i> <span>${label}</span>`;
    lucide.createIcons();
  }
}

function updateTemperature(temperature) {
  // Update numeric labels and unit text
  document.getElementById('temp-value').innerText = temperature.toFixed(1);
  
  // Recalculate progress arc from latest value (map -10C to 60C range, circumference is 125.66)
  const tempPct = Math.min(Math.max(((temperature + 10) / 70) * 100, 0), 100);
  const tempOffset = 125.66 - (125.66 * tempPct) / 100;
  document.getElementById('temp-gauge-path').setAttribute('stroke-dashoffset', tempOffset);

  // Update progress bar fill
  document.getElementById('temp-progress-fill').style.width = `${tempPct}%`;

  // Compare every new WebSocket packet with the previous packet to show trends
  const trendBadge = document.getElementById('temp-trend-badge');
  let prevTemp = consolePackets.length > 1 ? consolePackets[consolePackets.length - 2].temp : null;
  if (prevTemp !== null && trendBadge) {
    const iconName = temperature > prevTemp ? 'trending-up' : (temperature < prevTemp ? 'trending-down' : 'minus');
    const color = temperature > prevTemp ? 'var(--accent-orange)' : (temperature < prevTemp ? 'var(--accent-emerald)' : 'var(--text-muted)');
    const bg = temperature > prevTemp ? 'rgba(251, 146, 60, 0.08)' : (temperature < prevTemp ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)');
    const label = temperature > prevTemp ? 'Increasing' : (temperature < prevTemp ? 'Decreasing' : 'Stable');

    trendBadge.style.color = color;
    trendBadge.style.backgroundColor = bg;
    trendBadge.innerHTML = `<i data-lucide="${iconName}" size="12"></i> <span>${label}</span>`;
    lucide.createIcons();
  }
}

function updateHumidity(humidity) {
  // Update numeric labels and unit text
  document.getElementById('hum-value').innerText = humidity.toFixed(1);
  
  // Recalculate progress arc from latest value (map 0% to 100%, circumference is 125.66)
  const humPct = Math.min(Math.max(humidity, 0), 100);
  const humOffset = 125.66 - (125.66 * humPct) / 100;
  document.getElementById('hum-gauge-path').setAttribute('stroke-dashoffset', humOffset);

  // Update progress bar fill
  document.getElementById('hum-progress-fill').style.width = `${humPct}%`;

  // Compare every new WebSocket packet with the previous packet to show trends
  const trendBadge = document.getElementById('hum-trend-badge');
  let prevHum = consolePackets.length > 1 ? consolePackets[consolePackets.length - 2].humidity : null;
  if (prevHum !== null && trendBadge) {
    const iconName = humidity > prevHum ? 'trending-up' : (humidity < prevHum ? 'trending-down' : 'minus');
    const color = humidity > prevHum ? 'var(--accent-sky)' : (humidity < prevHum ? 'var(--accent-emerald)' : 'var(--text-muted)');
    const bg = humidity > prevHum ? 'rgba(56, 189, 248, 0.08)' : (humidity < prevHum ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)');
    const label = humidity > prevHum ? 'Increasing' : (humidity < prevHum ? 'Decreasing' : 'Stable');

    trendBadge.style.color = color;
    trendBadge.style.backgroundColor = bg;
    trendBadge.innerHTML = `<i data-lucide="${iconName}" size="12"></i> <span>${label}</span>`;
    lucide.createIcons();
  }
}

function updateStatus(status) {
  const badgeText = document.getElementById('status-badge-text');
  const footerState = document.getElementById('status-footer-state');
  const iconBox = document.getElementById('status-icon-box');

  badgeText.innerText = status;
  badgeText.className = `status-badge-visual ${status}`;
  footerState.innerText = status;

  const iconName = status === 'SAFE' ? 'shield-check' : (status === 'WARNING' ? 'alert-triangle' : 'shield-x');
  const color = status === 'SAFE' ? 'var(--accent-emerald)' : (status === 'WARNING' ? 'var(--accent-amber)' : 'var(--accent-rose)');
  
  if (iconBox) {
    iconBox.innerHTML = `<i data-lucide="${iconName}" size="16" style="color: ${color};"></i>`;
  }

  lucide.createIcons();
}

// Append rows directly to dashboard events feed (Last 20)
function appendDashboardEventRow(data) {
  const tbody = document.getElementById('dashboard-events-tbody');
  
  // Create row
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${data.timestamp}</td>
    <td style="font-weight: 700;">${data.smoke}</td>
    <td>${data.temp.toFixed(1)}</td>
    <td>${data.humidity.toFixed(1)}</td>
    <td style="text-align: right;">
      <span class="status-badge-inline ${data.status}">${data.status}</span>
    </td>
  `;

  // Remove placeholder if present
  const placeholder = tbody.querySelector('tr td[colspan]');
  if (placeholder) {
    tbody.innerHTML = '';
  }

  tbody.insertBefore(tr, tbody.firstChild);

  // Cap at 20 elements
  if (tbody.children.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

// ==========================================
// 4. Audio Alarms synthesizer (Web Audio API)
// ==========================================
function startSiren() {
  if (!soundEnabled || sirenInterval) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    let toggle = false;

    sirenInterval = setInterval(() => {
      if (!audioCtx) return;
      
      try {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        // Alternating siren tones
        osc.frequency.setValueAtTime(toggle ? 600 : 900, audioCtx.currentTime);
        osc.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.45);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.45);
        
        toggle = !toggle;
      } catch (e) {
        console.error('Audio synthesis beep failed', e);
      }
    }, 500);
  } catch (e) {
    console.error('Failed to initialize AudioContext', e);
  }
}

function stopSiren() {
  if (sirenInterval) {
    clearInterval(sirenInterval);
    sirenInterval = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

// ==========================================
// 5. WebSocket Client Gateways (OOP Architecture)
// ==========================================
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.connectionTimeoutTimer = null;
    this.reconnectCount = 0;
    this.url = '';
    this.connectStartTime = 0;
    this.timeoutDuration = 5000; // 5 seconds connection timeout
  }

  // Load URL from localStorage or fallback
  loadUrl() {
    try {
      let savedUrl = localStorage.getItem('smoke_dashboard_url');
      if (!savedUrl) {
        savedUrl = 'ws://10.101.0.97:8765';
      }
      this.url = savedUrl.trim();
      console.log("Current URL:", this.url);

      const cardIp = document.getElementById('conn-card-ip');
      const activeUrl = document.getElementById('active-ws-url');
      if (cardIp) cardIp.innerText = this.url;
      if (activeUrl) activeUrl.innerText = this.url;
    } catch (e) {
      console.error("Exception loading WebSocket URL:", e);
    }
  }

  // Set and save new URL
  setUrl(newUrl) {
    try {
      newUrl = newUrl.trim();
      if (!newUrl.startsWith('ws://')) {
        throw new Error("URL must begin with 'ws://'");
      }
      this.url = newUrl;
      localStorage.setItem('smoke_dashboard_url', newUrl);
      console.log("Current URL updated and saved:", this.url);

      const cardIp = document.getElementById('conn-card-ip');
      const activeUrl = document.getElementById('active-ws-url');
      if (cardIp) cardIp.innerText = this.url;
      if (activeUrl) activeUrl.innerText = this.url;

      // Disconnect existing and connect immediately
      this.disconnect();
      this.connect();
    } catch (e) {
      console.error("Exception setting WebSocket URL:", e);
      throw e;
    }
  }

  connect() {
    try {
      if (this.ws) {
        console.warn("WebSocket connection attempt ignored: duplicate connection prevented.");
        return;
      }
      this.clearReconnectTimer();
      this.clearConnectionTimeoutTimer();

      console.log("Connecting...");
      console.log(`Attempting connection to: ${this.url}`);

      this.updateStatus('CONNECTING');
      this.connectStartTime = Date.now();
      
      this.ws = new WebSocket(this.url);

      // Start connection timeout timer (5 seconds)
      this.connectionTimeoutTimer = setTimeout(() => {
        try {
          if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            console.log("Connection failed");
            console.warn(`Connection attempt to ${this.url} timed out after ${this.timeoutDuration / 1000}s`);
            console.log("Disconnected");
            this.disconnect();
            this.scheduleReconnect();
          }
        } catch (err) {
          console.error("Exception inside connection timeout callback:", err);
        }
      }, this.timeoutDuration);

      this.ws.onopen = () => {
        try {
          this.clearConnectionTimeoutTimer();
          const latencyVal = Date.now() - this.connectStartTime;
          console.log("Connected successfully");
          console.log("Connected");
          this.reconnectCount = 0;
          this.updateStatus('CONNECTED', latencyVal);
        } catch (err) {
          console.error("Exception in WebSocket onopen handler:", err);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          console.log("Packet Received");
          handleIncomingPacket(event.data);
        } catch (err) {
          console.error("Exception in WebSocket onmessage handler:", err);
        }
      };

      this.ws.onclose = (event) => {
        try {
          this.clearConnectionTimeoutTimer();
          console.log("Disconnected");
          console.log("Connection failed");
          console.log(`Close Details: Error = ${event.wasClean ? 'None' : 'Close Abruptly'}, Code = ${event.code}, Reason = ${event.reason || 'None'}`);
          this.ws = null;
          this.updateStatus('DISCONNECTED');
          this.scheduleReconnect();
        } catch (err) {
          console.error("Exception in WebSocket onclose handler:", err);
        }
      };

      this.ws.onerror = (error) => {
        try {
          console.error("WebSocket network socket error:", error);
        } catch (err) {
          console.error("Exception in WebSocket onerror handler:", err);
        }
      };

    } catch (e) {
      console.error("Exception during WebSocket connection establishment:", e);
      this.ws = null;
      this.updateStatus('DISCONNECTED');
      this.scheduleReconnect();
    }
  }

  disconnect() {
    try {
      this.clearReconnectTimer();
      this.clearConnectionTimeoutTimer();
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
        this.ws = null;
        console.log("Disconnected manually");
      }
      this.updateStatus('DISCONNECTED');
    } catch (e) {
      console.error("Exception during WebSocket safe disconnect:", e);
    }
  }

  scheduleReconnect() {
    try {
      if (this.reconnectTimer) return;

      this.reconnectCount++;
      console.log("Reconnect Count:", this.reconnectCount);
      console.log("Retrying...");

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 3000);
    } catch (e) {
      console.error("Exception scheduling reconnection timer:", e);
    }
  }

  clearReconnectTimer() {
    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    } catch (e) {
      console.error("Exception clearing reconnection timer:", e);
    }
  }

  clearConnectionTimeoutTimer() {
    try {
      if (this.connectionTimeoutTimer) {
        clearTimeout(this.connectionTimeoutTimer);
        this.connectionTimeoutTimer = null;
      }
    } catch (e) {
      console.error("Exception clearing connection timeout timer:", e);
    }
  }

  updateStatus(state, latency = null) {
    try {
      updateConnectionStatus(state, latency);
    } catch (e) {
      console.error("Exception during connection status update hook:", e);
    }
  }
}

// Update DOM Connection indicators
function updateConnectionStatus(state, latency = null) {
  const topPill = document.getElementById('top-conn-pill');
  const latencyLabel = document.getElementById('top-conn-latency');
  const piIndicator = document.getElementById('top-pi-status');

  const cardStatus = document.getElementById('conn-card-status');
  const cardLatency = document.getElementById('conn-card-latency');

  if (!topPill || !latencyLabel || !piIndicator || !cardStatus || !cardLatency) return;

  if (state === 'CONNECTED') {
    piIndicator.className = 'status-indicator online';
    topPill.className = 'connection-status-pill connected';
    topPill.querySelector('span').innerText = 'ONLINE';
    topPill.querySelector('i').setAttribute('data-lucide', 'wifi');
    
    latencyLabel.style.display = 'inline-block';
    latencyLabel.innerText = `${latency !== null ? latency : 0}ms`;

    cardStatus.innerText = 'ONLINE';
    cardStatus.style.color = 'var(--accent-emerald)';
    cardLatency.innerText = `${latency !== null ? latency : 0} ms`;

    showToast('WebSocket connected successfully.', 'success');
  } else if (state === 'CONNECTING') {
    piIndicator.className = 'status-indicator warning';
    topPill.className = 'connection-status-pill connecting';
    topPill.querySelector('span').innerText = 'CONNECTING';
    topPill.querySelector('i').setAttribute('data-lucide', 'refresh-cw');
    
    latencyLabel.style.display = 'none';

    cardStatus.innerText = 'CONNECTING';
    cardStatus.style.color = 'var(--accent-amber)';
    cardLatency.innerText = 'N/A';
  } else {
    // DISCONNECTED / OFFLINE
    piIndicator.className = 'status-indicator offline';
    topPill.className = 'connection-status-pill disconnected';
    topPill.querySelector('span').innerText = 'OFFLINE';
    topPill.querySelector('i').setAttribute('data-lucide', 'wifi-off');
    
    latencyLabel.style.display = 'none';

    cardStatus.innerText = 'OFFLINE';
    cardStatus.style.color = 'var(--accent-rose)';
    cardLatency.innerText = 'N/A';

    stopSiren();

    // Freeze graphs by stopping updates, show offline overlays, and keep existing lines (never reset to 0)
    showOfflineOverlays();
  }

  lucide.createIcons();
}

// Update running session aggregates
function updateStats(data) {
  stats.packetsCount++;
  
  if (data.smoke > stats.maxSmoke) stats.maxSmoke = data.smoke;
  if (data.smoke < stats.minSmoke) stats.minSmoke = data.smoke;

  stats.totalTemp += data.temp;
  stats.totalHum += data.humidity;

  if (data.status === 'DANGER') stats.dangerCount++;
  else if (data.status === 'WARNING') stats.warningCount++;
  else stats.safeCount++;

  localStorage.setItem('smoke_dashboard_stats', JSON.stringify(stats));

  const avgTemp = stats.totalTemp / stats.packetsCount;
  const avgHum = stats.totalHum / stats.packetsCount;

  document.getElementById('stats-max-smoke').innerText = `${stats.maxSmoke} ppm`;
  document.getElementById('stats-min-smoke').innerText = `${stats.minSmoke === Infinity ? 0 : stats.minSmoke} ppm`;
  document.getElementById('stats-avg-temp').innerText = `${avgTemp.toFixed(1)} °C`;
  document.getElementById('stats-avg-hum').innerText = `${avgHum.toFixed(1)} %`;

  document.getElementById('stats-safe-count').innerText = stats.safeCount;
  document.getElementById('stats-warn-count').innerText = stats.warningCount;
  document.getElementById('stats-danger-count').innerText = stats.dangerCount;
}

// Evaluate sirens and colors during DANGER/WARNING states
function evaluateStatusAlerts(status) {
  const banner = document.getElementById('alarm-banner');
  const bannerIcon = document.getElementById('alarm-banner-icon-inner');
  const bannerTitle = document.getElementById('alarm-banner-title');
  const bannerDesc = document.getElementById('alarm-banner-desc');
  const bannerBadge = document.getElementById('alarm-banner-badge');

  if (status === 'DANGER') {
    banner.className = 'alarm-banner state-danger alarm-glowing alarm-flash-bg shake-active';
    bannerIcon.setAttribute('data-lucide', 'shield-alert');
    bannerIcon.classList.add('text-blink');
    
    bannerTitle.className = 'text-blink';
    bannerTitle.innerText = 'SMOKE DETECTED';
    bannerDesc.innerHTML = 'EVACUATE IMMEDIATELY &bull; SIREN ACTIVE';
    bannerBadge.innerText = 'DANGER ACTIVE';

    startSiren();

    if (lastStatus !== 'DANGER' && toastEnabled) {
      showToast('Smoke Critical - EVACUATE IMMEDIATELY!', 'error');
    }
  } else if (status === 'WARNING') {
    banner.className = 'alarm-banner state-warning';
    bannerIcon.setAttribute('data-lucide', 'alert-triangle');
    bannerIcon.classList.remove('text-blink');
    
    bannerTitle.classList.remove('text-blink');
    bannerTitle.innerText = 'Smoke Increasing';
    bannerDesc.innerText = 'Warning: Smoke readings have exceeded standard levels. Inspect environment.';
    bannerBadge.innerText = 'WARNING';

    stopSiren();

    if (lastStatus !== 'WARNING' && lastStatus !== 'DANGER' && toastEnabled) {
      showToast('Smoke Increasing - System Warning', 'warning');
    }
  } else {
    // SAFE Status
    banner.className = 'alarm-banner state-safe';
    bannerIcon.setAttribute('data-lucide', 'shield-check');
    bannerIcon.classList.remove('text-blink');
    
    bannerTitle.classList.remove('text-blink');
    bannerTitle.innerText = 'System Normal';
    bannerDesc.innerText = 'All environmental sensors reporting safe levels. No smoke detected.';
    bannerBadge.innerText = 'Safe Status';

    stopSiren();

    if (lastStatus && lastStatus !== 'SAFE' && toastEnabled) {
      showToast('System Normal - Levels Secure', 'success');
    }
  }

  lastStatus = status;
  lucide.createIcons();
}

// ==========================================
// 6. History Page Log list & Exports
// ==========================================
let historyFilteredList = [];

function renderHistoryTable() {
  const tbody = document.getElementById('history-logs-tbody');
  const searchVal = document.getElementById('history-search-smoke').value.trim();
  const filterVal = document.getElementById('history-filter-status').value;
  const countLabel = document.getElementById('history-records-count');

  // Populate history from consolePackets
  let result = [...consolePackets];

  if (filterVal !== 'ALL') {
    result = result.filter(evt => evt.status === filterVal);
  }

  if (searchVal !== '') {
    const minSmoke = parseInt(searchVal, 10);
    if (!isNaN(minSmoke)) {
      result = result.filter(evt => evt.smoke >= minSmoke);
    }
  }

  historyFilteredList = result;
  countLabel.innerText = `Records: ${result.length}`;

  if (result.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 32px; font-style: italic;">
          Waiting for Sensor Data...
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = result.map(item => {
    return `
      <tr>
        <td class="td-mono">${item.timestamp}</td>
        <td style="font-weight: 700; color: var(--text-primary);">${item.smoke}</td>
        <td>${item.temp.toFixed(2)}</td>
        <td>${item.humidity.toFixed(2)}</td>
        <td style="text-align: right;">
          <span class="status-badge-inline ${item.status}">${item.status}</span>
        </td>
      </tr>
    `;
  }).join('');
}

// Exports handlers for History Log
function exportHistoryCSV() {
  if (historyFilteredList.length === 0) {
    showToast('No logs to export!', 'error');
    return;
  }

  const headers = ['Timestamp', 'Smoke Level (PPM)', 'Temperature (C)', 'Humidity (%)', 'Status'];
  const rows = historyFilteredList.map(evt => [
    evt.timestamp,
    evt.smoke,
    evt.temp.toFixed(2),
    evt.humidity.toFixed(2),
    evt.status
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' 
    + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  
  triggerDownload(csvContent, `smoke_detector_history_${Date.now()}.csv`);
}

function exportHistoryJSON() {
  if (historyFilteredList.length === 0) {
    showToast('No logs to export!', 'error');
    return;
  }

  const jsonContent = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(historyFilteredList, null, 2));
  
  triggerDownload(jsonContent, `smoke_detector_history_${Date.now()}.json`);
}

function downloadHistoryLogs() {
  if (historyFilteredList.length === 0) {
    showToast('No logs to download!', 'error');
    return;
  }

  const logLines = historyFilteredList.map(evt => {
    return `[${evt.timestamp}] STATUS=${evt.status} SMOKE=${evt.smoke}ppm TEMP=${evt.temp.toFixed(2)}C HUMIDITY=${evt.humidity.toFixed(2)}%`;
  });

  const textContent = 'data:text/plain;charset=utf-8,' + encodeURIComponent(logLines.join('\n'));
  
  triggerDownload(textContent, `smoke_detector_system_${Date.now()}.log`);
}

function triggerDownload(urlContent, filename) {
  const link = document.createElement('a');
  link.setAttribute('href', urlContent);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast(`Downloaded: ${filename}`, 'success');
}

// ==========================================
// 7. Navigation (SPA tab switcher) & Layouts
// ==========================================
function setupTabNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.view-section');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target');

      navItems.forEach(el => el.classList.remove('active'));
      item.classList.add('active');

      sections.forEach(sec => {
        if (sec.getAttribute('id') === target) {
          sec.classList.add('active-view');
        } else {
          sec.classList.remove('active-view');
        }
      });

      document.getElementById('sidebar').classList.remove('mobile-open');
    });
  });

  document.getElementById('menu-toggle-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
  });
}

// Clock tick updates
function tickClock() {
  const clockElement = document.getElementById('top-clock');
  setInterval(() => {
    const now = new Date();
    clockElement.innerText = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }, 1000);
}

// Slide-in toast notification banner popup
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  else if (type === 'warning') iconName = 'alert-triangle';
  else if (type === 'error') iconName = 'alert-octagon';

  toast.innerHTML = `
    <i data-lucide="${iconName}" style="flex-shrink: 0;"></i>
    <span style="flex-grow: 1;">${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.animation = 'slide-in 0.3s reverse forwards';
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 4000);
}

// ==========================================
// 8. Settings Page Configurations
// ==========================================
function loadSettingsForm() {
  const ipInput = document.getElementById('settings-ip-input');
  const warnInput = document.getElementById('settings-warn-input');
  const dangerInput = document.getElementById('settings-danger-input');
  const soundToggle = document.getElementById('settings-sound-toggle');
  const toastToggle = document.getElementById('settings-toast-toggle');
  const btnDark = document.getElementById('theme-btn-dark');
  const btnLight = document.getElementById('theme-btn-light');

  // Load configuration caches
  ipInput.value = wsManager ? wsManager.url : '';
  warnInput.value = smokeWarningThreshold;
  dangerInput.value = smokeDangerThreshold;
  soundToggle.checked = soundEnabled;
  toastToggle.checked = toastEnabled;

  if (currentTheme === 'dark') {
    document.body.classList.remove('light-theme');
    btnDark.classList.add('active');
    btnLight.classList.remove('active');
  } else {
    document.body.classList.add('light-theme');
    btnLight.classList.add('active');
    btnDark.classList.remove('active');
  }

  // Form listeners
  soundToggle.addEventListener('change', (e) => {
    soundEnabled = e.target.checked;
    localStorage.setItem('smoke_dashboard_sound', soundEnabled);
    if (!soundEnabled) stopSiren();
  });

  toastToggle.addEventListener('change', (e) => {
    toastEnabled = e.target.checked;
    localStorage.setItem('smoke_dashboard_toast', toastEnabled);
  });

  btnDark.addEventListener('click', () => {
    currentTheme = 'dark';
    document.body.classList.remove('light-theme');
    btnDark.classList.add('active');
    btnLight.classList.remove('active');
    localStorage.setItem('smoke_dashboard_theme', 'dark');
  });

  btnLight.addEventListener('click', () => {
    currentTheme = 'light';
    document.body.classList.add('light-theme');
    btnLight.classList.add('active');
    btnDark.classList.remove('active');
    localStorage.setItem('smoke_dashboard_theme', 'light');
  });

  document.getElementById('conn-reconnect-btn').addEventListener('click', () => {
    if (wsManager) {
      wsManager.disconnect();
      wsManager.connect();
    }
  });

  document.getElementById('stats-reset-btn').addEventListener('click', () => {
    stats = {
      maxSmoke: 0,
      minSmoke: Infinity,
      totalTemp: 0,
      totalHum: 0,
      packetsCount: 0,
      safeCount: 0,
      warnCount: 0,
      dangerCount: 0
    };
    localStorage.removeItem('smoke_dashboard_stats');
    
    document.getElementById('stats-max-smoke').innerText = '---';
    document.getElementById('stats-min-smoke').innerText = '---';
    document.getElementById('stats-avg-temp').innerText = '---';
    document.getElementById('stats-avg-hum').innerText = '---';
    document.getElementById('stats-safe-count').innerText = '0';
    document.getElementById('stats-warn-count').innerText = '0';
    document.getElementById('stats-danger-count').innerText = '0';

    showToast('Session stats reset.', 'info');
  });

  document.getElementById('settings-form-element').addEventListener('submit', (e) => {
    e.preventDefault();

    const rawInput = ipInput.value.trim();
    const newWarn = parseInt(warnInput.value, 10);
    const newDanger = parseInt(dangerInput.value, 10);

    if (!rawInput) {
      showToast('WebSocket Address cannot be empty!', 'error');
      return;
    }

    if (!rawInput.startsWith('ws://')) {
      showToast('WebSocket URL must start with "ws://"', 'error');
      return;
    }

    if (isNaN(newWarn) || isNaN(newDanger)) {
      showToast('Smoke threshold values must be valid numbers!', 'error');
      return;
    }

    if (newWarn >= newDanger) {
      showToast('Warning threshold must be less than Danger threshold!', 'error');
      return;
    }

    smokeWarningThreshold = newWarn;
    smokeDangerThreshold = newDanger;

    localStorage.setItem('smoke_dashboard_warn', smokeWarningThreshold);
    localStorage.setItem('smoke_dashboard_danger', smokeDangerThreshold);

    showToast('Preferences successfully updated.', 'success');

    if (wsManager && rawInput !== wsManager.url) {
      try {
        wsManager.setUrl(rawInput);
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  // History filtering input listeners
  document.getElementById('history-search-smoke').addEventListener('input', renderHistoryTable);
  document.getElementById('history-filter-status').addEventListener('change', renderHistoryTable);
  document.getElementById('btn-export-csv').addEventListener('click', exportHistoryCSV);
  document.getElementById('btn-export-json').addEventListener('click', exportHistoryJSON);
  document.getElementById('btn-export-logs').addEventListener('click', downloadHistoryLogs);
}

// ==========================================
// 9. Lifecycle Initialization
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  if (currentTheme === 'light') {
    document.body.classList.add('light-theme');
  }

  setupTabNavigation();
  tickClock();

  // Instantiate WebSocket Manager
  wsManager = new WebSocketManager();
  wsManager.loadUrl();
  wsManager.connect();

  loadSettingsForm();
  
  // Instantiate empty Line charts
  initRealTimeCharts();

  lucide.createIcons();
});
