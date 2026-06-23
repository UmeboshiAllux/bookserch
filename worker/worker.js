/**
 * 次の一冊 — Cloudflare Worker プロキシ
 *
 * 役割:
 *  1. Google Books API への代理リクエスト（キーをユーザーに見せない）
 *  2. Claude API への代理リクエスト（推薦理由文の生成のみ・キーを見せない）
 *  3. 月間予算の上限管理（KVでカウント、上限到達でClaude呼び出しを自動停止）
 *  4. IPごとのレート制限（バズった場合の濫用防止）
 *
 * 必要なシークレット（wrangler secret put で設定）:
 *   - GOOGLE_BOOKS_API_KEY
 *   - ANTHROPIC_API_KEY
 *
 * 必要なKV namespace（wrangler.toml で binding）:
 *   - RATE_LIMIT_KV
 */

// ═══════════════════════════════════════════════════════════
// 設定値（ここを変えるだけで上限を調整できる）
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  // Claude呼び出しの月間上限回数（Haiku 4.5、1回あたり約0.17円換算で
  // 3000回 ≈ 500円。少し余裕を見て2500回に設定）
  MONTHLY_CLAUDE_CALL_LIMIT: 2500,

  // 1日あたりのClaude呼び出し上限（月初に一気に使い切られるのを防ぐ）
  DAILY_CLAUDE_CALL_LIMIT: 150,

  // IPごとのレート制限（1時間あたりの最大リクエスト数）
  IP_RATE_LIMIT_PER_HOUR: 20,

  // Claudeのモデル（コストを抑えるためHaikuを既定にする）
  CLAUDE_MODEL: 'claude-haiku-4-5-20251001',

  CLAUDE_MAX_TOKENS: 250,
};

// ═══════════════════════════════════════════════════════════
// CORS ヘッダー
// ═══════════════════════════════════════════════════════════
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ═══════════════════════════════════════════════════════════
// KVヘルパー: 日付ベースのキーでカウントを管理
// ═══════════════════════════════════════════════════════════
function getMonthKey() {
  const d = new Date();
  return `claude_calls_month_${d.getUTCFullYear()}_${d.getUTCMonth() + 1}`;
}
function getDayKey() {
  const d = new Date();
  return `claude_calls_day_${d.getUTCFullYear()}_${d.getUTCMonth() + 1}_${d.getUTCDate()}`;
}
function getIpKey(ip) {
  const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
  return `ip_${ip}_${hourBucket}`;
}

async function incrementAndGet(kv, key, ttlSeconds) {
  const current = await kv.get(key);
  const next = (parseInt(current || '0', 10)) + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

async function getCount(kv, key) {
  const v = await kv.get(key);
  return parseInt(v || '0', 10);
}

// ═══════════════════════════════════════════════════════════
// IPレート制限チェック
// ═══════════════════════════════════════════════════════════
async function checkIpRateLimit(kv, ip) {
  const key = getIpKey(ip);
  const count = await incrementAndGet(kv, key, 3600); // 1時間で自動失効
  return count <= CONFIG.IP_RATE_LIMIT_PER_HOUR;
}

// ═══════════════════════════════════════════════════════════
// Claude呼び出し予算チェック（月間・日次の両方）
// ═══════════════════════════════════════════════════════════
async function canCallClaude(kv) {
  const monthCount = await getCount(kv, getMonthKey());
  const dayCount = await getCount(kv, getDayKey());
  if (monthCount >= CONFIG.MONTHLY_CLAUDE_CALL_LIMIT) return { ok: false, reason: 'monthly_limit' };
  if (dayCount >= CONFIG.DAILY_CLAUDE_CALL_LIMIT) return { ok: false, reason: 'daily_limit' };
  return { ok: true };
}

async function recordClaudeCall(kv) {
  // 月間カウントは40日で失効（月またぎの余裕を持たせる）
  await incrementAndGet(kv, getMonthKey(), 60 * 60 * 24 * 40);
  // 日次カウントは2日で失効
  await incrementAndGet(kv, getDayKey(), 60 * 60 * 24 * 2);
}

// ═══════════════════════════════════════════════════════════
// ハンドラ: Google Books 検索の代理
// ═══════════════════════════════════════════════════════════
async function handleBooksSearch(request, env, origin) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const maxResults = url.searchParams.get('maxResults') || '20';
  const startIndex = url.searchParams.get('startIndex') || '0';
  const langRestrict = url.searchParams.get('langRestrict') || '';
  const country = url.searchParams.get('country') || '';

  if (!query) {
    return jsonResponse({ error: 'query (q) is required' }, 400, origin);
  }

  let gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}`
            + `&maxResults=${encodeURIComponent(maxResults)}&startIndex=${encodeURIComponent(startIndex)}`
            + `&printType=books&key=${env.GOOGLE_BOOKS_API_KEY}`;
  if (langRestrict) gbUrl += `&langRestrict=${encodeURIComponent(langRestrict)}`;
  if (country) gbUrl += `&country=${encodeURIComponent(country)}`;

  try {
    const res = await fetch(gbUrl);
    const data = await res.json();
    return jsonResponse(data, res.status, origin);
  } catch (e) {
    return jsonResponse({ error: 'Google Books fetch failed: ' + e.message }, 502, origin);
  }
}

// ═══════════════════════════════════════════════════════════
// ハンドラ: Claude 推薦理由生成の代理
// ═══════════════════════════════════════════════════════════
async function handleReasonGeneration(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const kv = env.RATE_LIMIT_KV;

  // IPレート制限
  const ipOk = await checkIpRateLimit(kv, ip);
  if (!ipOk) {
    return jsonResponse({ error: 'rate_limited', message: 'リクエストが多すぎます。しばらく待ってください。' }, 429, origin);
  }

  // 予算チェック（月間・日次）
  const budgetCheck = await canCallClaude(kv);
  if (!budgetCheck.ok) {
    // 上限到達はエラーではなく「フォールバックすべき」という通常レスポンスとして返す
    return jsonResponse({ fallback: true, reason: budgetCheck.reason }, 200, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid JSON body' }, 400, origin);
  }

  const { title1, title2, bookTitle, bookAuthor, axisA, axisB } = body;
  if (!title1 || !title2 || !bookTitle) {
    return jsonResponse({ error: 'title1, title2, bookTitle are required' }, 400, origin);
  }

  const prompt = `あなたは読書案内人です。以下の情報をもとに、推薦理由を2文程度の自然な日本語で書いてください。

ユーザーが読んだ2冊: 「${title1}」「${title2}」
今回推薦する本: 「${bookTitle}」（著者: ${bookAuthor || '不明'}）
注目すべき共通点の軸: ${axisA || ''} / ${axisB || ''}

説明文や前置きは不要です。推薦理由の本文のみを出力してください。`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return jsonResponse({ fallback: true, reason: 'api_error', detail: errText.slice(0, 200) }, 200, origin);
    }

    const data = await res.json();
    await recordClaudeCall(kv);

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // 入出力ペアをログとして保存（品質改善・傾向把握のため）
    await saveLog(kv, { title1, title2, bookTitle, bookAuthor, reason: text });

    return jsonResponse({ fallback: false, reason: text }, 200, origin);

  } catch (e) {
    return jsonResponse({ fallback: true, reason: 'network_error', detail: e.message }, 200, origin);
  }
}

// ═══════════════════════════════════════════════════════════
// ログ保存・取得
// ═══════════════════════════════════════════════════════════
function getLogKey() {
  // 日付ベースのキーでログをまとめる（例: logs_2026_06_21）
  const d = new Date();
  return `logs_${d.getUTCFullYear()}_${String(d.getUTCMonth()+1).padStart(2,'0')}_${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function saveLog(kv, entry) {
  try {
    const key = getLogKey();
    const existing = await kv.get(key);
    const logs = existing ? JSON.parse(existing) : [];
    logs.push({ ...entry, at: new Date().toISOString() });
    // 1日分のログが膨らみすぎないよう最新200件に絞る
    const trimmed = logs.slice(-200);
    await kv.put(key, JSON.stringify(trimmed), { expirationTtl: 60 * 60 * 24 * 60 }); // 60日保持
  } catch (e) {
    // ログ保存失敗は本体の動作に影響させない
  }
}

async function handleLogs(request, env, origin) {
  const kv = env.RATE_LIMIT_KV;
  const url = new URL(request.url);
  // ?days=7 のように日数を指定可能（デフォルト: 今日のみ）
  const days = Math.min(parseInt(url.searchParams.get('days') || '1', 10), 30);

  const result = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = `logs_${d.getUTCFullYear()}_${String(d.getUTCMonth()+1).padStart(2,'0')}_${String(d.getUTCDate()).padStart(2,'0')}`;
    try {
      const raw = await kv.get(key);
      if (raw) result.push(...JSON.parse(raw));
    } catch (e) {}
  }

  // 新しい順に並べて返す
  result.sort((a, b) => new Date(b.at) - new Date(a.at));
  return jsonResponse({ count: result.length, logs: result }, 200, origin);
}

// ═══════════════════════════════════════════════════════════
// ハンドラ: 現在の利用状況を返す（デバッグ・透明性のため）
// ═══════════════════════════════════════════════════════════
async function handleStatus(env, origin) {
  const kv = env.RATE_LIMIT_KV;
  const monthCount = await getCount(kv, getMonthKey());
  const dayCount = await getCount(kv, getDayKey());
  return jsonResponse({
    monthly_claude_calls: monthCount,
    monthly_limit: CONFIG.MONTHLY_CLAUDE_CALL_LIMIT,
    daily_claude_calls: dayCount,
    daily_limit: CONFIG.DAILY_CLAUDE_CALL_LIMIT,
  }, 200, origin);
}

// ═══════════════════════════════════════════════════════════
// ハンドラ: ログダッシュボード UI
// ═══════════════════════════════════════════════════════════
async function handleLogsDashboard(request, env) {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>次の一冊 — ログダッシュボード</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',sans-serif;background:#f5f4f0;color:#1a1714;padding:1.5rem;font-size:14px}
h1{font-size:1.1rem;font-weight:600;margin-bottom:1.5rem;color:#333}
.controls{display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:1.5rem;align-items:center}
.controls select,.controls input{padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;background:#fff}
.tab-row{display:flex;gap:4px;margin-bottom:1rem;flex-wrap:wrap}
.tab{padding:6px 14px;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:12px;background:#fff;color:#555}
.tab.active{background:#1a1714;color:#fff;border-color:#1a1714}
.panel{display:none}.panel.active{display:block}
.card{background:#fff;border:1px solid #e0ddd7;border-radius:6px;padding:1rem;margin-bottom:1rem}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.75rem;margin-bottom:1.5rem}
.stat{background:#fff;border:1px solid #e0ddd7;border-radius:6px;padding:0.9rem;text-align:center}
.stat-num{font-size:1.8rem;font-weight:700;color:#2d4a8a}
.stat-label{font-size:0.7rem;color:#888;margin-top:2px}
.budget-bar-wrap{height:4px;background:#eee;border-radius:2px;margin-top:6px;overflow:hidden}
.budget-bar{height:100%;background:#2d4a8a;border-radius:2px;transition:width 0.4s;width:0%}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:6px 8px;border-bottom:2px solid #e0ddd7;font-size:11px;color:#888;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid #f0ede8;vertical-align:top;word-break:break-all}
tr:hover td{background:#faf9f7}
.rank-bar{height:8px;background:#2d4a8a;border-radius:4px;margin-top:3px;min-width:4px}
.reason-text{font-size:11px;color:#666;max-width:300px;line-height:1.5}
.time{font-size:11px;color:#aaa;white-space:nowrap}
canvas{max-width:100%;display:block}
.empty{text-align:center;padding:2rem;color:#aaa;font-size:13px}
.loading{text-align:center;padding:2rem;color:#aaa}
</style>
</head>
<body>
<h1>📚 次の一冊 — ログダッシュボード</h1>

<div class="controls">
  <label>期間:
    <select id="days-select" onchange="loadData()">
      <option value="1">今日</option>
      <option value="7" selected>過去7日</option>
      <option value="14">過去14日</option>
      <option value="30">過去30日</option>
    </select>
  </label>
  <span id="status-info" style="font-size:12px;color:#888"></span>
  <button onclick="loadData()" style="padding:6px 12px;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:12px">更新</button>
</div>

<div class="stat-row" id="stat-row">
  <div class="stat"><div class="stat-num" id="s-total">-</div><div class="stat-label">総推薦数</div></div>
  <div class="stat"><div class="stat-num" id="s-unique-in">-</div><div class="stat-label">ユニーク入力本</div></div>
  <div class="stat"><div class="stat-num" id="s-unique-out">-</div><div class="stat-label">ユニーク推薦本</div></div>
  <div class="stat"><div class="stat-num" id="s-monthly">-</div><div class="stat-label">今月Claude利用</div><div class="budget-bar-wrap"><div class="budget-bar" id="budget-bar-month"></div></div></div>
  <div class="stat"><div class="stat-num" id="s-daily">-</div><div class="stat-label">本日Claude利用</div><div class="budget-bar-wrap"><div class="budget-bar" id="budget-bar-day"></div></div></div>
</div>

<div class="tab-row">
  <button class="tab active" onclick="showTab('timeline')">タイムライン</button>
  <button class="tab" onclick="showTab('top-rec')">推薦ランキング</button>
  <button class="tab" onclick="showTab('top-in')">入力ランキング</button>
  <button class="tab" onclick="showTab('chart')">日別グラフ</button>
</div>

<div id="panel-timeline" class="panel active">
  <div class="card">
    <table>
      <thead><tr><th>日時</th><th>入力1</th><th>入力2</th><th>推薦</th><th>推薦理由</th></tr></thead>
      <tbody id="tbl-timeline"></tbody>
    </table>
  </div>
</div>

<div id="panel-top-rec" class="panel">
  <div class="card">
    <table>
      <thead><tr><th>順位</th><th>推薦された本</th><th>著者</th><th>回数</th></tr></thead>
      <tbody id="tbl-top-rec"></tbody>
    </table>
  </div>
</div>

<div id="panel-top-in" class="panel">
  <div class="card">
    <table>
      <thead><tr><th>順位</th><th>入力された本</th><th>回数</th></tr></thead>
      <tbody id="tbl-top-in"></tbody>
    </table>
  </div>
</div>

<div id="panel-chart" class="panel">
  <div class="card">
    <canvas id="chart-canvas" height="200"></canvas>
  </div>
</div>

<script>
let allLogs = [];
let maxBarWidth = 1;

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['timeline','top-rec','top-in','chart'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  if (name === 'chart') drawChart();
}

async function loadData() {
  const days = document.getElementById('days-select').value;
  document.getElementById('status-info').textContent = '読み込み中…';

  try {
    const [logsRes, statusRes] = await Promise.all([
      fetch('/logs?days=' + days),
      fetch('/status')
    ]);
    const logsData = await logsRes.json();
    const statusData = await statusRes.json();

    allLogs = logsData.logs || [];
    renderAll(allLogs, statusData);
    document.getElementById('status-info').textContent = allLogs.length + '件取得（' + days + '日分）';
  } catch(e) {
    document.getElementById('status-info').textContent = '取得失敗: ' + e.message;
  }
}

function renderAll(logs, status) {
  // 統計
  const inTitles = logs.flatMap(l => [l.title1, l.title2]).filter(Boolean);
  const outTitles = logs.map(l => l.bookTitle).filter(Boolean);
  document.getElementById('s-total').textContent = logs.length;
  document.getElementById('s-unique-in').textContent = new Set(inTitles).size;
  document.getElementById('s-unique-out').textContent = new Set(outTitles).size;

  const mCalls = status.monthly_claude_calls || 0;
  const mLimit = status.monthly_limit || 2500;
  const dCalls = status.daily_claude_calls || 0;
  const dLimit = status.daily_limit || 150;
  document.getElementById('s-monthly').textContent = mCalls + '/' + mLimit;
  document.getElementById('s-daily').textContent = dCalls + '/' + dLimit;

  const mPct = Math.min(100, Math.round(mCalls / mLimit * 100));
  const dPct = Math.min(100, Math.round(dCalls / dLimit * 100));
  const mBar = document.getElementById('budget-bar-month');
  const dBar = document.getElementById('budget-bar-day');
  mBar.style.width = mPct + '%';
  mBar.style.background = mPct > 80 ? '#e05' : '#2d4a8a';
  dBar.style.width = dPct + '%';
  dBar.style.background = dPct > 80 ? '#e05' : '#2d4a8a';

  // タイムライン
  const tbody = document.getElementById('tbl-timeline');
  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">データがありません</td></tr>';
  } else {
    tbody.innerHTML = logs.slice(0, 100).map(l => {
      const d = new Date(l.at);
      const time = (d.getMonth()+1) + '/' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      return '<tr>' +
        '<td class="time">' + time + '</td>' +
        '<td>' + esc(l.title1||'') + '</td>' +
        '<td>' + esc(l.title2||'') + '</td>' +
        '<td><strong>' + esc(l.bookTitle||'') + '</strong><br><span style="color:#888;font-size:11px">' + esc(l.bookAuthor||'') + '</span></td>' +
        '<td class="reason-text">' + esc((l.reason||'').slice(0,80)) + (l.reason&&l.reason.length>80?'…':'') + '</td>' +
        '</tr>';
    }).join('');
  }

  // 推薦ランキング
  const recCount = {};
  const recAuthor = {};
  logs.forEach(l => {
    if (!l.bookTitle) return;
    recCount[l.bookTitle] = (recCount[l.bookTitle]||0) + 1;
    recAuthor[l.bookTitle] = l.bookAuthor || '';
  });
  const recSorted = Object.entries(recCount).sort((a,b)=>b[1]-a[1]).slice(0,20);
  const recMax = recSorted[0]?.[1] || 1;
  document.getElementById('tbl-top-rec').innerHTML = recSorted.length === 0
    ? '<tr><td colspan="4" class="empty">データがありません</td></tr>'
    : recSorted.map(([title, cnt], i) =>
      '<tr><td style="color:#888">' + (i+1) + '</td><td><strong>' + esc(title) + '</strong>' +
      '<div class="rank-bar" style="width:' + Math.round(cnt/recMax*200) + 'px"></div></td>' +
      '<td style="color:#888;font-size:11px">' + esc(recAuthor[title]) + '</td>' +
      '<td><strong>' + cnt + '</strong></td></tr>'
    ).join('');

  // 入力ランキング
  const inCount = {};
  logs.forEach(l => {
    if (l.title1) inCount[l.title1] = (inCount[l.title1]||0) + 1;
    if (l.title2) inCount[l.title2] = (inCount[l.title2]||0) + 1;
  });
  const inSorted = Object.entries(inCount).sort((a,b)=>b[1]-a[1]).slice(0,20);
  const inMax = inSorted[0]?.[1] || 1;
  document.getElementById('tbl-top-in').innerHTML = inSorted.length === 0
    ? '<tr><td colspan="3" class="empty">データがありません</td></tr>'
    : inSorted.map(([title, cnt], i) =>
      '<tr><td style="color:#888">' + (i+1) + '</td><td><strong>' + esc(title) + '</strong>' +
      '<div class="rank-bar" style="width:' + Math.round(cnt/inMax*200) + 'px"></div></td>' +
      '<td><strong>' + cnt + '</strong></td></tr>'
    ).join('');
}

function drawChart() {
  const canvas = document.getElementById('chart-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.parentElement.clientWidth - 32;
  canvas.width = W;

  // 日別集計
  const dayCounts = {};
  allLogs.forEach(l => {
    const d = new Date(l.at);
    const key = (d.getMonth()+1) + '/' + d.getDate();
    dayCounts[key] = (dayCounts[key]||0) + 1;
  });

  const days = parseInt(document.getElementById('days-select').value);
  const labels = [];
  const values = [];
  for (let i = days-1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = (d.getMonth()+1) + '/' + d.getDate();
    labels.push(key);
    values.push(dayCounts[key] || 0);
  }

  if (labels.length === 0) { ctx.fillText('データなし', W/2, 100); return; }

  const H = 200, padL = 30, padB = 30, padT = 20, padR = 10;
  const maxVal = Math.max(...values, 1);
  const barW = Math.max(4, (W - padL - padR) / labels.length - 4);

  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#aaa';

  // Y軸グリッド
  [0, 0.25, 0.5, 0.75, 1].forEach(ratio => {
    const y = padT + (H - padT - padB) * (1 - ratio);
    ctx.strokeStyle = '#eee';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(Math.round(maxVal * ratio), 2, y + 3);
  });

  // バー
  labels.forEach((label, i) => {
    const x = padL + i * (W - padL - padR) / labels.length + 2;
    const barH = (H - padT - padB) * (values[i] / maxVal);
    const y = H - padB - barH;
    ctx.fillStyle = '#2d4a8a';
    ctx.fillRect(x, y, barW, barH);
    if (labels.length <= 14 || i % 2 === 0) {
      ctx.fillStyle = '#aaa';
      ctx.fillText(label, x, H - 5);
    }
    if (values[i] > 0) {
      ctx.fillStyle = '#333';
      ctx.fillText(values[i], x + barW/2 - 3, y - 3);
    }
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

loadData();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ═══════════════════════════════════════════════════════════
// メインルーター
// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/books/search' && request.method === 'GET') {
        return await handleBooksSearch(request, env, origin);
      }
      if (url.pathname === '/reason' && request.method === 'POST') {
        return await handleReasonGeneration(request, env, origin);
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        return await handleStatus(env, origin);
      }
      if (url.pathname === '/logs' && request.method === 'GET') {
        return await handleLogs(request, env, origin);
      }
      if (url.pathname === '/logs-ui') {
        return await handleLogsDashboard(request, env);
      }
      return jsonResponse({ error: 'not found' }, 404, origin);
    } catch (e) {
      return jsonResponse({ error: 'internal error', detail: e.message }, 500, origin);
    }
  },
};
