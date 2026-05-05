// ── Helpers ───────────────────────────────────────────────────
const g = id => document.getElementById(id);
const setText = (id, val) => { const el = g(id); if (el) el.textContent = val; };

// ── Config ────────────────────────────────────────────────────
const CFG = {
  broker:   'b93d41ad7b6242dbb8659cb6dce95f18.s1.eu.hivemq.cloud',
  port:     8884,
  user:     'Dinar',
  pass:     'DinarSiot1',
  topic:    'iot/sensor',
  topicCmd: 'iot/relay/cmd',   // ← REVISI: topik perintah ke ESP32
  tblInt:   1000,              // ← REVISI: interval table update 1 detik
  maxRows:  50,
  maxChart: 30,
};

// ── State ─────────────────────────────────────────────────────
let cl = null, conn = false, manualDisc = false;
let lastStatus = '', lastData = null, lastTblTime = 0;
let st = null, uptimer = null;
let history = [], nextId = 1;
let webRelayState = [false, false, false, false]; // state relay di web

// ── View Navigation ───────────────────────────────────────────
function goToDashboard() {
  const login = g('view-login'), dash = g('view-dashboard');
  login.classList.add('fade-out');
  setTimeout(() => {
    login.classList.add('hidden'); login.classList.remove('fade-out');
    dash.classList.remove('hidden'); dash.classList.add('fade-in');
    window.scrollTo(0, 0);
    setTimeout(initChart, 50);
  }, 320);
}

function goToLogin() {
  g('view-dashboard').classList.add('hidden');
  g('view-dashboard').classList.remove('fade-in');
  g('view-login').classList.remove('hidden');
  window.scrollTo(0, 0);
}

// ── Chart ─────────────────────────────────────────────────────
let dhtChart = null;
const chartLabels = [], chartSuhu = [], chartHum = [];

/**
 * Hitung batas sumbu Y berdasarkan data aktual.
 * Memberikan padding 2 unit di atas dan bawah nilai min/max.
 */
function calcAxisRange(dataArr, fallbackMin, fallbackMax) {
  if (!dataArr.length) return { min: fallbackMin, max: fallbackMax };
  const min = Math.min(...dataArr);
  const max = Math.max(...dataArr);
  const pad = Math.max((max - min) * 0.2, 2); // padding minimal 2 unit
  return {
    min: Math.floor(min - pad),
    max: Math.ceil(max + pad),
  };
}

function initChart() {
  const ctx = g('dht-chart');
  if (!ctx || dhtChart) return;

  const makeAxis = (color, pos) => ({
    type: 'linear', position: pos,
    ticks: {
      color,
      font: { family: "'Fira Code', monospace", size: 9 },
      callback: v => v + (pos === 'left' ? '°C' : '%'),
      maxTicksLimit: 6,
    },
    grid:   pos === 'left' ? { color: 'rgba(14,165,233,.05)' } : { drawOnChartArea: false },
    border: { color: pos === 'left' ? 'rgba(14,165,233,.1)' : 'rgba(56,189,248,.1)' },
    // Nilai awal saat belum ada data
    suggestedMin: pos === 'left' ? 20 : 40,
    suggestedMax: pos === 'left' ? 35 : 80,
  });

  dhtChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: 'Suhu (°C)',
          data: chartSuhu,
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14,165,233,.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#0ea5e9',
          tension: 0.4,
          fill: true,
          yAxisID: 'ySuhu',
        },
        {
          label: 'Kelembapan (%)',
          data: chartHum,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,.06)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#38bdf8',
          tension: 0.4,
          fill: true,
          yAxisID: 'yHum',
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 300 },
      plugins: {
        // Sembunyikan legenda bawaan Chart.js (sudah ada legenda manual di HTML)
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1526',
          borderColor: 'rgba(14,165,233,.3)',
          borderWidth: 1,
          titleColor: '#4d7fa8',
          bodyColor: '#bfdbfe',
          padding: 10,
          titleFont: { family: "'Fira Code', monospace", size: 10 },
          bodyFont:  { family: "'Fira Code', monospace", size: 11 },
          callbacks: {
            // Tampilkan nilai dengan 1 desimal di tooltip hover
            label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#4d7fa8',
            font: { family: "'Fira Code', monospace", size: 9 },
            maxTicksLimit: 8, // Batasi label sumbu X agar tidak penuh
            maxRotation: 0,   // Jangan rotasi label
          },
          grid: { color: 'rgba(14,165,233,.05)' },
          border: { color: 'rgba(14,165,233,.1)' },
        },
        ySuhu: makeAxis('#0ea5e9', 'left'),
        yHum:  makeAxis('#38bdf8', 'right'),
      },
    },
  });
}

/**
 * Update badge nilai terkini di atas grafik (di luar canvas).
 * Menggantikan tooltip yang muncul di pojok kiri grafik.
 */
function updChartBadge(suhu, hum) {
  const vs = g('chart-val-suhu');
  const vh = g('chart-val-hum');
  const vt = g('chart-val-time');
  if (vs) vs.textContent = suhu.toFixed(1);
  if (vh) vh.textContent = hum.toFixed(1);
  if (vt) vt.textContent = new Date().toLocaleTimeString('id-ID', { hour12: false });
}

/**
 * Tambah titik data baru dan perbarui skala Y secara dinamis
 * sesuai rentang data aktual yang masuk.
 */
function pushChart(suhu, hum) {
  if (!dhtChart) initChart();

  chartLabels.push(new Date().toLocaleTimeString('id-ID', { hour12: false }));
  chartSuhu.push(suhu);
  chartHum.push(hum);

  // Buang data terlama jika melebihi batas maxChart
  if (chartLabels.length > CFG.maxChart) {
    chartLabels.shift(); chartSuhu.shift(); chartHum.shift();
  }

  // Hitung ulang rentang sumbu Y berdasarkan data aktual
  const rSuhu = calcAxisRange(chartSuhu, 20, 35);
  const rHum  = calcAxisRange(chartHum, 40, 80);

  dhtChart.options.scales.ySuhu.min = rSuhu.min;
  dhtChart.options.scales.ySuhu.max = rSuhu.max;
  dhtChart.options.scales.yHum.min  = Math.max(0, rHum.min);
  dhtChart.options.scales.yHum.max  = Math.min(100, rHum.max);

  dhtChart.update('none'); // 'none' = update tanpa animasi ulang agar smooth

  // Update badge nilai terkini di atas grafik
  updChartBadge(suhu, hum);
}

function clearChart() {
  chartLabels.length = chartSuhu.length = chartHum.length = 0;
  if (dhtChart) {
    // Reset skala ke default saat data dikosongkan
    dhtChart.options.scales.ySuhu.min = 20;
    dhtChart.options.scales.ySuhu.max = 35;
    dhtChart.options.scales.yHum.min  = 40;
    dhtChart.options.scales.yHum.max  = 80;
    dhtChart.update();
  }
}

// ── Persistence ───────────────────────────────────────────────
function saveHistory() {
  try { localStorage.setItem('iot_hist', JSON.stringify({ rows: history, nextId })); } catch(e) {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem('iot_hist');
    if (!raw) return;
    const obj = JSON.parse(raw);
    history = obj.rows || []; nextId = obj.nextId || history.length + 1;
    rebuildTable(); updateMsgCount(); updateSelInfo();
    const lu = localStorage.getItem('last_update');
    if (lu) setText('lu', lu);
    const last = localStorage.getItem('last_sensor');
    if (last) { const d = JSON.parse(last); if (d.suhu) updSensor(d.suhu, d.hum); if (d.cahaya) updLDR(d.cahaya); }
  } catch(e) {}
}

// ── Table ─────────────────────────────────────────────────────
function rebuildTable() {
  const tb = g('tbl-body');
  tb.innerHTML = history.length ? '' : '<tr><td colspan="7" class="no-data">Belum ada data diterima.</td></tr>';
  history.forEach(r => tb.appendChild(makeRow(r)));
  g('chk-all').checked = false;
  g('del-btn').disabled = true;
}

function makeRow(r) {
  const tr = document.createElement('tr');
  tr.dataset.id = r.id;
  tr.innerHTML = `
    <td><input type="checkbox" class="row-cb" data-id="${r.id}" onchange="onRowCheck()"></td>
    <td>${r.id}</td><td>${r.ts}</td>
    <td class="suhu-cell">${r.suhu}</td><td class="hum-cell">${r.hum}</td>
    <td>${r.cahaya === 'TERANG' ? '<span class="bt">TERANG</span>' : '<span class="bg">GELAP</span>'}</td>
    <td>${r.led}</td>`;
  tr.onclick = e => { if (e.target.type === 'checkbox') return; const cb = tr.querySelector('.row-cb'); cb.checked = !cb.checked; onRowCheck(); };
  return tr;
}

function addTableRow(now, suhu, hum, cahaya, ledRaw) {
  const names = ['LED1','LED2','LED3','LED4'];
  let aktif = [];
  if (typeof ledRaw === 'string' && /^[01]{4}$/.test(ledRaw))
    ledRaw.split('').forEach((v, i) => { if (v === '1') aktif.push(names[i]); });
  else if (Array.isArray(ledRaw))
    ledRaw.forEach(n => { if (n >= 1 && n <= 4) aktif.push(names[n - 1]); });

  const row = {
    id: nextId++,
    ts: now.toLocaleTimeString('id-ID', { hour12: false }),
    suhu: suhu != null ? suhu.toFixed(1) : '-',
    hum:  hum  != null ? hum.toFixed(1)  : '-',
    cahaya, led: aktif.length ? aktif.join(', ') : '-'
  };
  history.unshift(row);
  if (history.length > CFG.maxRows) history.length = CFG.maxRows;

  const tb = g('tbl-body');
  const noRow = tb.querySelector('.no-data');
  if (noRow) noRow.parentElement.remove();
  tb.insertBefore(makeRow(row), tb.firstChild);
  while (tb.children.length > CFG.maxRows) tb.removeChild(tb.lastChild);
  updateSelInfo(); saveHistory(); updateMsgCount();
}

// ── Checkbox ──────────────────────────────────────────────────
function onRowCheck() {
  const cbs = [...document.querySelectorAll('.row-cb')];
  const checked = cbs.filter(c => c.checked);
  g('chk-all').checked = checked.length === cbs.length && cbs.length > 0;
  g('del-btn').disabled = !checked.length;
  document.querySelectorAll('#tbl-body tr[data-id]').forEach(tr =>
    tr.classList.toggle('selected', !!tr.querySelector('.row-cb')?.checked));
  updateSelInfo();
}

function toggleAll(master) {
  document.querySelectorAll('.row-cb').forEach(cb => cb.checked = master.checked);
  onRowCheck();
}

function updateSelInfo() {
  const n = [...document.querySelectorAll('.row-cb:checked')].length;
  setText('sel-info', history.length ? (n ? `${n} baris dipilih` : `${history.length} baris`) : '');
}

function updateMsgCount() { setText('mc', history.length); }

function deleteSelected() {
  const ids = new Set([...document.querySelectorAll('.row-cb:checked')].map(c => +c.dataset.id));
  if (!ids.size) return;
  history = history.filter(r => !ids.has(r.id));
  saveHistory(); rebuildTable(); updateSelInfo(); updateMsgCount();
  g('chk-all').checked = false; g('del-btn').disabled = true;
}

function clearAll() {
  if (!history.length || !confirm('Hapus semua riwayat data?')) return;
  history = []; nextId = 1;
  saveHistory(); rebuildTable(); updateSelInfo(); updateMsgCount();
}

function exportCSV() {
  if (!history.length) { alert('Tidak ada data.'); return; }
  const rows = [['#','Waktu','Suhu (°C)','Hum (%)','Cahaya','LED'], ...history.map(r => [r.id,r.ts,r.suhu,r.hum,r.cahaya,r.led])];
  const a = Object.assign(document.createElement('a'), {
    href: 'data:text/csv;charset=utf-8,' + encodeURI(rows.map(r => r.join(',')).join('\n')),
    download: `iot-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.csv`
  });
  a.click();
}

// ── MQTT ──────────────────────────────────────────────────────
function toggle() { conn ? doDisc() : doConn(); }

function doConn() {
  manualDisc = false; setBadge('connecting', 'CONNECTING...'); g('btn').disabled = true;
  cl = new Paho.Client(CFG.broker, CFG.port, '/mqtt', 'Web-' + Math.floor(Math.random() * 9000 + 1000));
  cl.onConnectionLost = onLost;
  cl.onMessageArrived = onMsg;
  cl.connect({ userName: CFG.user, password: CFG.pass, useSSL: true, keepAliveInterval: 30, cleanSession: true, onSuccess: onConn, onFailure: onFail });
}

function doDisc() {
  if (!cl || !conn) return;
  manualDisc = true; cl.disconnect();
  setText('btn-text', 'HUBUNGKAN KE MQTT');
  g('btn').classList.remove('disc'); g('btn').disabled = false;
  setBadge('', 'DISCONNECTED');
}

function onConn() {
  conn = true; setBadge('connected', 'CONNECTED');
  g('btn').disabled = false; g('btn').classList.add('disc');
  setText('btn-text', 'PUTUSKAN KONEKSI');
  cl.subscribe(CFG.topic);
  addLog('SYS', 'Connected: ' + CFG.broker);
  addLog('SYS', 'Topic: ' + CFG.topic);
  st = Date.now(); uptimer = setInterval(uptime, 1000);
}

function onFail(e) { setBadge('error', 'GAGAL'); addLog('SYS', 'Error: ' + e.errorMessage); g('btn').disabled = false; }

function onLost() {
  conn = false; setBadge('', 'DISCONNECTED'); g('btn').disabled = false;
  if (uptimer) clearInterval(uptimer);
  setSystemState('off');
  setText('btn-text', 'HUBUNGKAN KE MQTT'); g('btn').classList.remove('disc');
  if (!manualDisc) { addLog('SYS', 'Koneksi terputus, mencoba ulang...'); setTimeout(doConn, 3000); }
  manualDisc = false;
}

function onMsg(m) {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour12: false });
    setText('lu', timeStr); localStorage.setItem('last_update', timeStr);

    const d      = JSON.parse(m.payloadString.trim());
    const mode   = (d.mode || 'auto').toLowerCase();
    const suhu   = d.suhu       != null ? parseFloat(d.suhu)       : null;
    const hum    = d.kelembapan != null ? parseFloat(d.kelembapan) : null;
    const cahaya = (d.cahaya || '').toUpperCase();

    lastData = { suhu, hum, cahaya };
    localStorage.setItem('last_sensor', JSON.stringify(lastData));

    updModeBadge(mode, suhu);
    if (suhu != null && hum != null) { updSensor(suhu, hum); pushChart(suhu, hum); }
    if (cahaya) updLDR(cahaya);

    if (mode === 'manual') {
      const led = parseLed(d.led);
      addLog('MODE', 'MANUAL');
      addLog('LED', `L1:${+led[0]} L2:${+led[1]} L3:${+led[2]} L4:${+led[3]}`);
      updLEDs(led, 'manual');
      setSystemState('manual');
      // Sync state web relay dengan kondisi hardware
      webRelayState = [...led];
      syncWebControlButtons(led);
    } else {
      if (suhu == null || hum == null) { addLog('ERR', 'Data tidak lengkap'); return; }
      addLog('SUHU', suhu.toFixed(1) + ' °C');
      addLog('HUM',  hum.toFixed(1)  + ' %');
      addLog('LDR',  cahaya || '—');
      setSystemState('auto', suhu); updLEDs(null, 'auto', suhu); cekAlert(suhu);
      // Mode AUTO: nonaktifkan tombol web control
      setWebControlEnabled(false, 'auto');
    }

    if (Date.now() - lastTblTime >= CFG.tblInt) {
      addTableRow(now, suhu, hum, cahaya, d.led);
      lastTblTime = Date.now();
    }
  } catch(e) { addLog('ERR', 'Pesan error: ' + e.message); }
}

function parseLed(led) {
  const s = [false, false, false, false];
  if (led == null) return s;
  if (Array.isArray(led))                                    led.forEach(n => { if (n >= 1 && n <= 4) s[n-1] = true; });
  else if (typeof led === 'string' && /^[01]{4}$/.test(led)) led.split('').forEach((v, i) => s[i] = v === '1');
  else if (typeof led === 'number')                          for (let i = 0; i < 4; i++) s[i] = !!(led & (1 << i));
  return s;
}

// ── Web Relay Control (FITUR BARU) ────────────────────────────

/**
 * Kirim perintah toggle satu relay ke ESP32 via MQTT
 * @param {number} relay - nomor relay 1-4
 */
function toggleRelayWeb(relay) {
  if (!conn) { addLog('ERR', 'Belum terhubung ke MQTT'); return; }
  const idx = relay - 1;
  const newState = !webRelayState[idx];
  webRelayState[idx] = newState;

  const payload = JSON.stringify({ relay, state: newState });
  const msg = new Paho.Message(payload);
  msg.destinationName = CFG.topicCmd;
  cl.send(msg);

  addLog('WEB', `Relay ${relay} -> ${newState ? 'ON' : 'OFF'}`);
  // Update tampilan tombol segera (optimistic UI)
  updWebBtn(relay, newState);
}

/**
 * Kirim perintah semua relay sekaligus
 * @param {string} pattern - '0000' s/d '1111'
 */
function sendAllRelay(pattern) {
  if (!conn) { addLog('ERR', 'Belum terhubung ke MQTT'); return; }
  const msg = new Paho.Message(JSON.stringify({ led: pattern }));
  msg.destinationName = CFG.topicCmd;
  cl.send(msg);
  webRelayState = pattern.split('').map(v => v === '1');
  addLog('WEB', `ALL RELAY: ${pattern}`);
  webRelayState.forEach((on, i) => updWebBtn(i + 1, on));
}

/**
 * Update tampilan 1 tombol web control
 */
function updWebBtn(relay, on) {
  const btn = g(`web-btn-${relay}`);
  if (!btn) return;
  btn.className = 'web-relay-btn ' + (on ? 'active' : '');
  btn.querySelector('.web-btn-status').textContent = on ? 'ON' : 'OFF';
}

/**
 * Sync semua tombol web sesuai state LED dari hardware
 */
function syncWebControlButtons(ledArr) {
  ledArr.forEach((on, i) => {
    webRelayState[i] = on;
    updWebBtn(i + 1, on);
  });
  setWebControlEnabled(true, 'manual');
}

/**
 * Enable/disable tombol web control
 */
function setWebControlEnabled(enabled, mode) {
  const panel = g('web-control-panel');
  if (!panel) return;
  const hint = g('web-control-hint');
  if (enabled) {
    panel.classList.remove('disabled');
    if (hint) hint.textContent = 'Mode MANUAL aktif — tombol web berfungsi';
    if (hint) hint.className = 'dim web-hint-on';
  } else {
    panel.classList.add('disabled');
    if (hint) hint.textContent = mode === 'auto'
      ? 'Mode AUTO — relay dikontrol otomatis oleh suhu'
      : 'Hubungkan MQTT untuk kontrol relay';
    if (hint) hint.className = 'dim';
  }
}

// ── UI Updates ────────────────────────────────────────────────
function updSensor(suhu, hum) {
  setText('sv', suhu.toFixed(1)); setText('hv', hum.toFixed(1));
  g('sb').style.width = Math.min(100, (suhu / 50) * 100) + '%';
  g('hb').style.width = Math.min(100, hum) + '%';
}

function updLDR(v) {
  const terang = v === 'TERANG';
  setText('lico', terang ? '☀️' : '🌙');
  g('lpill').className   = 'pill ' + (terang ? 'terang' : 'gelap');
  g('lpill').textContent = terang ? 'TERANG' : 'GELAP';
}

function updModeBadge(mode, suhu) {
  const isManual = mode === 'manual';
  g('mode-badge').className = 'mode-badge ' + (isManual ? 'manual' : 'auto');
  setText('mode-text', isManual ? 'MODE: MANUAL' : 'MODE: AUTO');
  setText('mode-hint', isManual ? 'LED dikontrol via tombol fisik / web' : (suhu != null ? 'LED dari suhu ' + suhu.toFixed(1) + '°C' : 'LED dari suhu sensor'));
}

function setSystemState(state, suhu) {
  const sv = g('sval');
  if (state === 'auto') {
    sv.textContent = 'AKTIF'; sv.className = 'big-text on';
    setText('snote', 'STATUS: ' + (suhu <= 25 ? 'NORMAL' : suhu <= 30 ? 'SEDANG' : 'PANAS') + ' | ' + suhu.toFixed(1) + '°C');
  } else if (state === 'manual') {
    sv.textContent = 'MANUAL'; sv.className = 'big-text on';
    setText('snote', 'Kontrol LED via tombol fisik / web');
  } else {
    sv.textContent = 'STANDBY'; sv.className = 'big-text';
    setText('snote', 'Menunggu data dari ESP32...');
    g('mode-badge').className = 'mode-badge';
    setText('mode-text', 'MODE: —'); setText('mode-hint', 'Menunggu data...');
    setWebControlEnabled(false, 'disconnected');
  }
}

function updLEDs(state, mode, suhu) {
  const colors = ['green', 'yellow', 'red', 'green'];
  [1,2,3,4].forEach(i => { g('l'+i).className = 'lorb'; setText('ls'+i, 'Padam'); });
  if (mode === 'manual') {
    [0,1,2,3].forEach(i => {
      setText('lb'+(i+1), 'BTN '+(i+1));
      if (state[i]) { g('l'+(i+1)).className = 'lorb ' + colors[i]; setText('ls'+(i+1), 'Menyala'); }
    });
  } else {
    ['20–25°C','26–30°C','≥30°C','INDIKATOR'].forEach((v, i) => setText('lb'+(i+1), v));
    const idx = suhu >= 20 && suhu <= 25 ? 0 : suhu > 25 && suhu <= 30 ? 1 : suhu > 30 ? 2 : -1;
    if (idx >= 0) { g('l'+(idx+1)).className = 'lorb ' + colors[idx]; setText('ls'+(idx+1), 'Menyala'); }
    g('l4').className = 'lorb green'; setText('ls4', 'Aktif');
  }
}

function cekAlert(suhu) {
  const s = suhu <= 25 ? 'NORMAL' : suhu <= 30 ? 'SEDANG' : 'PANAS';
  if (s !== lastStatus) {
    const map = { NORMAL: ['● Suhu Normal (20–25°C)', 'green'], SEDANG: ['● Suhu Sedang (26–30°C)', 'yellow'], PANAS: ['● Suhu Panas (>30°C)', 'red'] };
    showAlert(...map[s]);
  }
  lastStatus = s;
}

// ── Helpers ───────────────────────────────────────────────────
function setBadge(cls, txt) { g('badge').className = 'badge ' + cls; setText('btext', txt); }

function addLog(type, msg) {
  const el = g('log');
  const t  = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const cls = msg.includes('TERANG') || msg.includes('AKTIF') || msg.includes('ON') ? 'on-txt'
            : msg.includes('GELAP')  || msg.includes('STANDBY') ? 'muted' : '';
  const d = Object.assign(document.createElement('div'), { className: 'le' });
  d.innerHTML = `<span class="lt">${t}</span> <span class="lk">[${type}]</span> <span class="lm ${cls}">${msg}</span>`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 120) el.removeChild(el.firstChild);
}

function uptime() {
  if (!st || !g('up')) return;
  const s = Math.floor((Date.now() - st) / 1000);
  setText('up', String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
}

function showAlert(text, type) {
  const div = Object.assign(document.createElement('div'), { className: 'alert-box alert-' + type, innerText: text });
  document.body.appendChild(div); setTimeout(() => div.remove(), 3200);
}

window.addEventListener('load', loadHistory);
