// js/dashboard.js - the Dashboard screen: tiles, charts and filters.
// A Today/Week/Month/Year filter (dashRange) drives the sales trend. Range
// numbers come from the dashboard_data() RPC (schema.sql). Stock, expiring
// batches and supplier debt are snapshots fetched once per visit. Every chart
// and list keeps a fixed-size placeholder when empty, so a new pharmacy never
// sees a broken layout.

var dashRange = 'week';
var dashLoading = false;
var dashStale = false;  // true while old numbers are shown and fresh ones are loading

// The last dashboard is also saved on this device so the next visit opens with
// numbers instead of placeholders. Cleared on log out. Skipped for custom
// date ranges and very large stock lists (localStorage is small).
var DASH_CACHE_KEY = 'hodhi_dash_cache_v2';  // v2: the week view became a rolling 7 days
function saveDashCache() {
  try {
    if (dashRange === 'custom') return;
    var s = JSON.stringify({ pid: STATE.profile.pharmacy_id, range: dashRange, snap: dashSnap, data: dashData, at: Date.now() });
    if (s.length < 800000) localStorage.setItem(DASH_CACHE_KEY, s);
  } catch (e) {}
}
function readDashCache() {
  try {
    var c = JSON.parse(localStorage.getItem(DASH_CACHE_KEY) || 'null');
    if (!c || c.pid !== STATE.profile.pharmacy_id || c.range !== dashRange || dashRange === 'custom') return null;
    if (Date.now() - c.at > 36 * 3600 * 1000) return null;
    return (c.snap && c.data) ? c : null;
  } catch (e) { return null; }
}
function clearDashCache() {
  dashSnap = null; dashData = null;
  try { localStorage.removeItem(DASH_CACHE_KEY); } catch (e) {}
}

// Text-free placeholder shapes shown while loading, in the places the real
// cards will appear, so nothing jumps when data arrives.
function dashSkeletonHtml() {
  var stat = '<div class="skel-card"><span class="skel" style="height:10px;width:55%"></span>' +
    '<span class="skel" style="height:24px;width:75%;margin-top:12px"></span></div>';
  return '<div class="skel-grid" aria-hidden="true">' + stat + stat + stat + stat + '</div>' +
    '<div class="skel-card" aria-hidden="true"><span class="skel" style="height:10px;width:35%"></span>' +
    '<span class="skel" style="height:120px;margin-top:12px"></span></div>' +
    '<div class="skel-card" aria-hidden="true"><span class="skel" style="height:10px;width:45%"></span>' +
    '<span class="skel" style="height:14px;margin-top:14px"></span>' +
    '<span class="skel" style="height:14px;margin-top:10px;width:85%"></span>' +
    '<span class="skel" style="height:14px;margin-top:10px;width:70%"></span></div>';
}
var dashData = null;  // last dashboard_data() result for the current dashRange
var dashSnap = null;  // snapshot: stock value and health, expiring, supplier debt

var DCOLOR = {
  sales: '#008300', salesLight: '#E3F3E3',
  // Sales graph line: dark navy, so it stands out on the green card.
  salesLine: '#14367A',
  blue: '#4D7AB3', blueLight: '#E7EEF6',
  violet: '#6F5FA0', violetLight: '#ECE8F7',
  orange: '#eb6834', orangeLight: '#FDEBE3',
  magenta: '#e87ba4', magentaLight: '#FCEAF1',
  critical: '#d03b3b', serious: '#ec835a', warning: '#fab219', good: '#0ca30c',
  ctxWarm: '#BE8F87',
  // Chart text uses the same dark ink as body text (no gray text rule). Only the
  // gridlines stay light.
  gridline: '#E7E2DC', inkSoft: '#201E1B'
};
var DASH_RANGE_LABELS = { today: 'Today', week: '7 Days', month: 'Month', year: 'Year', custom: 'Custom' };
var DASH_PERIOD_LABEL = { today: 'Today', week: 'Last 7 days', month: 'This month', year: 'This year', custom: 'Custom range' };
var DASH_VS_LABEL = { today: 'yesterday', week: 'the 7 days before', month: 'last month', year: 'last year', custom: 'the previous period' };
var DASH_TOPSELLERS_TITLE = { today: 'Top sellers today', week: 'Top sellers, last 7 days', month: 'Top sellers this month', year: 'Top sellers this year', custom: 'Top sellers' };
var RUSH_LABELS = ['12-3am', '3-6am', '6-9am', '9am-12pm', '12-3pm', '3-6pm', '6-9pm', '9pm-12am'];
// Custom date range from the calendar button. Set together with
// dashRange = 'custom'; cleared when a preset tab is tapped.
var dashCustomStart = null;
var dashCustomEnd = null;

// Chooses between the preset-range RPC and dashboard_data_custom() (a separate
// SQL function, so the presets are untouched). Used on first load and on every
// range switch.
function fetchDashboardData() {
  if (dashRange === 'custom' && dashCustomStart && dashCustomEnd) {
    return sb.rpc('dashboard_data_custom', { p_pharmacy_id: STATE.profile.pharmacy_id, p_start: dashCustomStart, p_end: dashCustomEnd });
  }
  return sb.rpc('dashboard_data', { p_pharmacy_id: STATE.profile.pharmacy_id, p_range: dashRange === 'custom' ? 'today' : dashRange });
}

async function renderDashboard() {
  var c = $('#content');
  // Show the last dashboard we have the moment the tab opens, with a thin
  // "updating" bar, then swap in fresh numbers. Placeholders only when there is
  // nothing to show yet.
  if (!dashSnap || !dashData) {
    var saved = readDashCache();
    if (saved) { dashSnap = saved.snap; dashData = saved.data; }
  }
  var hadStale = !!(dashSnap && dashData);
  if (hadStale) { dashStale = true; drawDashboard(); }
  else c.innerHTML = dashSkeletonHtml();
  try {
    // Five requests at once (the alerts one is optional). Out-of-stock and
    // low-stock lists are worked out from v_drug_stock here, and supplier debt
    // comes from a database function, so nothing is downloaded just to be added up.
    var results = await Promise.all([
      fetchAllRows(function () { return sb.from('v_drug_stock').select('drug_id,name,unit,qty_in_stock,reorder_level,stock_value_retail'); }, 'drug_id'),
      fetchAllRows(function () { return sb.from('v_expiring_batches').select('*').order('expiry_date'); }, 'id'),
      sb.rpc('supplier_owed_summary', { p_pharmacy_id: STATE.profile.pharmacy_id }),
      fetchDashboardData(),
      // Alerts (customer debts, refills due, controlled-drug mismatch, open stock
      // take). Optional: the dashboard still draws if this fails.
      sb.rpc('dashboard_extras', { p_pharmacy_id: STATE.profile.pharmacy_id }).then(function (r) { return r; }, function () { return { data: null }; })
    ]);
    var stockRes = results[0], expRes = results[1], oweRes = results[2], dashRes = results[3], extrasRes = results[4];
    if (dashRes.error) throw dashRes.error;
    if (stockRes.error) throw stockRes.error;

    var drugs = stockRes.data || [];
    var stockValue = drugs.reduce(function (a, r) { return a + Number(r.stock_value_retail || 0); }, 0);
    // Same rules as the v_out_of_stock and v_low_stock views in schema.sql:
    // out = no live stock; low = some stock, at or below the reorder level.
    var outList = drugs.filter(function (r) { return Number(r.qty_in_stock) === 0; })
      .map(function (r) { return { drug_id: r.drug_id, name: r.name, unit: r.unit }; });
    var lowList = drugs.filter(function (r) { var q = Number(r.qty_in_stock); return q > 0 && q <= Number(r.reorder_level); })
      .map(function (r) { return { drug_id: r.drug_id, name: r.name, unit: r.unit, qty_in_stock: r.qty_in_stock, reorder_level: r.reorder_level }; });
    var oweRow = (oweRes.data && oweRes.data[0]) || {};
    var supplierOwed = Number(oweRow.owed || 0), suppliersOwedCount = Number(oweRow.owed_count || 0);

    dashSnap = {
      stockValue: stockValue,
      drugCount: drugs.length,
      outOfStock: outList,
      lowStock: lowList,
      expiring: expRes.data || [],
      supplierOwed: supplierOwed,
      suppliersOwedCount: suppliersOwedCount,
      // Name and quantity list for the "is this drug in stock?" box, kept so each
      // keystroke needs no extra request.
      drugList: stockRes.data || [],
      extras: (extrasRes && !extrasRes.error && extrasRes.data) || null
    };
    dashData = dashRes.data;
    saveDashCache();
  } catch (e) {
    dashStale = false;
    // Keep the last numbers if we have them; only a first-ever load shows the retry card.
    if (STATE.tab !== 'dashboard') return;
    if (hadStale) { toast(friendlyError(e), 'bad'); drawDashboard(); }
    else errorCard(c, friendlyError(e), 'renderDashboard');
    return;
  }
  dashStale = false;
  // The person may have changed tab while loading; do not paint over it.
  if (STATE.tab === 'dashboard') drawDashboard();
}

async function setDashRange(r) {
  if (r === dashRange || dashLoading) return;
  dashRange = r;
  dashCustomStart = null; dashCustomEnd = null;  // a preset tab clears any custom range
  dashLoading = true;
  drawDashboard();  // instant feedback; range cards stay dimmed on the old data until the refetch lands
  try {
    var res = await fetchDashboardData();
    if (res.error) throw res.error;
    dashData = res.data;
  } catch (e) {
    toast(friendlyError(e), 'bad');
  }
  dashLoading = false;
  drawDashboard();
}

// From/to picker opened by the calendar button.
function openDashDateRangePicker() {
  var start = dashCustomStart || new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  var end = dashCustomEnd || new Date().toISOString().slice(0, 10);
  var body = sheet('Custom date range', '');
  body.innerHTML =
    '<div class="field"><label>From</label><input id="dashRangeFrom" type="date" value="' + esc(start) + '"></div>' +
    '<div class="field"><label>To</label><input id="dashRangeTo" type="date" value="' + esc(end) + '"></div>' +
    '<button class="btn primary" id="dashRangeApplyBtn" onclick="applyDashCustomRange()">Apply</button>';
}

async function applyDashCustomRange() {
  var from = $('#dashRangeFrom').value, to = $('#dashRangeTo').value;
  if (!from || !to) { toast('Pick both a from and a to date.', 'bad'); return; }
  if (to < from) { toast('The "to" date is before the "from" date.', 'bad'); return; }
  var btn = $('#dashRangeApplyBtn');
  act(btn, async function () {
    dashCustomStart = from; dashCustomEnd = to;
    dashRange = 'custom';
    dashLoading = true;
    closeSheet();
    drawDashboard();
    try {
      var res = await fetchDashboardData();
      if (res.error) throw res.error;
      dashData = res.data;
    } catch (e) {
      toast(friendlyError(e), 'bad');
    }
    dashLoading = false;
    drawDashboard();
  });
}

// "Restock" shortcut: opens Inventory's reorder list (openReorderList) from the
// stock already loaded here, so it opens instantly.
function dashQuickRestock() {
  if (dashSnap && dashSnap.drugList && dashSnap.drugList.length) {
    STATE.drugsCache = dashSnap.drugList;
    openReorderList();
  } else {
    setTab('inventory');
  }
}

// Mobile layout: alert strip, search box, Sell + Restock buttons, sales trend,
// then the 4-tile stat grid and stock health. Only the stat grid has tinted
// tiles. The rush-hours and Sales/Cost/Profit draw functions below are
// currently unused; kept in case they come back.
function drawDashboard() {
  var c = $('#content');
  var refetching = dashLoading ? ' dash-refetching' : '';
  c.innerHTML =
    (dashStale ? '<div class="updating-bar" aria-hidden="true"></div>' : '') +
    dashAlertHtml(dashSnap) +
    dashExtrasHtml(dashSnap) +
    dashQuickAccessHtml() +
    dashFilterRowHtml() +
    '<div class="card dash-graph-card t-sales' + refetching + '">' + dashSalesGraphHtml(dashData) + '</div>' +
    '<div class="dash-stat-grid' + refetching + '">' + dashStatGridHtml(dashData, dashSnap) + '</div>' +
    '<div class="card dash-list-card t-orange">' + dashStockHealthHtml(dashSnap) + '</div>' +
    '<div class="dash-row">' +
      '<div class="dash-col' + refetching + '">' + dashTopSellersCard(dashData) + '</div>' +
      '<div class="dash-col">' + dashExpiringCard(dashSnap) + '</div>' +
    '</div>';
}

// Urgent strip: out-of-stock count and the soonest-expiring batch (within
// 30 days), linking to Inventory. Draws nothing when nothing is urgent.
function dashAlertHtml(snap) {
  snap = snap || {};
  var outCount = (snap.outOfStock || []).length;
  var expiring = snap.expiring || [];
  var soonest = expiring.length ? expiring[0] : null;  // v_expiring_batches is already ordered by expiry_date
  var soonestDays = soonest ? daysUntil(soonest.expiry_date) : null;
  var parts = [];
  if (outCount) parts.push('<b>' + outCount + ' out of stock</b>');
  if (soonest && soonestDays !== null && soonestDays <= 30) {
    parts.push('<b>1 batch expires ' + (soonestDays < 0 ? 'already' : soonestDays === 0 ? 'today' : 'in ' + soonestDays + ' day' + (soonestDays === 1 ? '' : 's')) + '</b>');
  }
  if (!parts.length) return '';
  return '<div class="dash-alert" onclick="setTab(\'inventory\')">' + icon('warn', 16) +
    '<div>' + parts.join(' &middot; ') + ' — tap Stock to review</div></div>';
}

// Sell and Restock shortcuts plus the live "is this drug in stock?" search.
function dashQuickAccessHtml() {
  return '<div class="dash-actions">' +
    '<button class="btn primary" onclick="setTab(\'sell\')">' + icon('sell', 15) + ' Sell</button>' +
    '<button class="btn secondary" onclick="dashQuickRestock()">' + icon('box', 15) + ' Restock</button>' +
    '</div>' +
    '<div class="dash-quick-search">' +
    '<input id="dashStockCheckInput" placeholder="Check if a drug is in stock…" autocomplete="off" oninput="dashStockCheckSearch(this.value)" onblur="setTimeout(function(){var b=document.getElementById(\'dashStockCheckResults\');if(b)b.classList.remove(\'open\');},150)">' +
    '<div id="dashStockCheckResults" class="dash-quick-results"></div>' +
    '</div>';
}

function dashStockCheckSearch(val) {
  var box = $('#dashStockCheckResults');
  if (!box) return;
  var q = (val || '').trim().toLowerCase();
  if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }
  var matches = (dashSnap.drugList || []).filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
  box.classList.add('open');
  box.innerHTML = matches.length ? matches.map(function (d) {
    var kind = d.qty_in_stock === 0 ? 'bad' : d.qty_in_stock <= (d.reorder_level || 0) ? 'warn' : 'good';
    var badge = kind === 'bad' ? '<span class="badge bad">Out of stock</span>' : kind === 'warn' ? '<span class="badge warn">Low stock</span>' : '<span class="badge good">In stock</span>';
    return '<div class="dash-quick-result-row" onclick="dashStockCheckGoInventory(\'' + d.drug_id + '\')">' +
      '<div><div class="name">' + esc(d.name) + '</div><div class="meta">' + esc(qtyUnit(d.qty_in_stock, d.unit)) + ' available</div></div>' +
      '<div class="right">' + badge + '<button class="btn small secondary" style="margin-left:8px" onclick="event.stopPropagation();dashStockCheckSell(\'' + d.drug_id + '\')">Sell</button></div>' +
      '</div>';
  }).join('') : '<div class="dash-quick-result-row empty">No drug matches that search.</div>';
}

function dashStockCheckGoInventory(drugId) {
  var d = (dashSnap.drugList || []).filter(function (x) { return x.drug_id === drugId; })[0];
  invFilter = d ? d.name : '';
  invPage = 1;
  setTab('inventory');
}

function dashStockCheckSell(drugId) {
  var d = (dashSnap.drugList || []).filter(function (x) { return x.drug_id === drugId; })[0];
  sellFilter = d ? d.name : '';
  setTab('sell');
}

// Range control: pill-style Today/Week/Month/Year tabs plus a calendar button
// for a custom range (openDashDateRangePicker / applyDashCustomRange).
function dashFilterRowHtml() {
  var isCustom = dashRange === 'custom';
  return '<div class="dash-filter-row"><div class="dash-tabs">' +
    ['today', 'week', 'month', 'year'].map(function (r) {
      return '<button class="dash-tab' + (!isCustom && dashRange === r ? ' active' : '') + '" onclick="setDashRange(\'' + r + '\')">' + DASH_RANGE_LABELS[r] + '</button>';
    }).join('') +
    '</div>' +
    '<button class="dash-cal-btn' + (isCustom ? ' active' : '') + '" onclick="openDashDateRangePicker()" title="Custom date range">' + icon('calendar', 15) + '</button>' +
    '</div>' +
    (isCustom && dashCustomStart && dashCustomEnd ? '<div class="dash-custom-label">' + esc(fmtDate(dashCustomStart)) + ' – ' + esc(fmtDate(dashCustomEnd)) + '</div>' : '');
}

// ---- Charts ----
// Hairline gridlines, comma-formatted ticks, and a fixed viewBox so they scale to
// any width without clipping the axis. With no data, an honest "No sales
// recorded yet" caption is drawn inside the same fixed-size chart.

// Round the axis step up to 1/2/5/10 times a power of ten, so 4 * step is
// always >= the max value. With smaller steps a point like 250 on a 0-200 axis
// was drawn outside the chart.
function niceTicks(maxVal) {
  if (!maxVal || maxVal <= 0) return [0, 250, 500, 750, 1000];
  var rough = maxVal / 4;
  var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
  var norm = rough / mag;
  var step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag;
  var ticks = [];
  for (var i = 0; i <= 4; i++) ticks.push(Math.round(i * step));
  return ticks;
}
function fmtCompact(n) { return Math.round(n).toLocaleString(); }

// Drawn at the card's real pixel width (with right padding and thinned x-labels)
// so axis text stays readable and the last label is not clipped.
function dashChartW() {
  var c = document.getElementById('content');
  if (!c || !c.clientWidth) return 600;
  var cs = getComputedStyle(c);
  return Math.max(260, Math.round(c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 40));
}
function axisLineChart(values, labels, w, h, color, isEmpty) {
  var ticks = niceTicks(values.length ? Math.max.apply(null, values) : 0);
  var gutter = 46, padR = 20, plotW = w - gutter - padR, labelBand = 20, totalH = h + labelBand;
  // A week always shows every day name, a bit smaller on narrow screens.
  var labelEvery = labels.length <= 7 ? 1 : Math.max(1, Math.ceil(labels.length * 30 / Math.max(plotW, 1)));
  var labelSize = (labels.length <= 7 && plotW / Math.max(labels.length, 1) < 32) ? 10 : 11;
  var hi = ticks[ticks.length - 1] || 1;
  var n = Math.max(values.length, 1);
  function px(i) { return gutter + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2); }
  function py(v) { return h - (v / hi) * (h - 8) - 4; }
  var grid = '', ticksHtml = '', axisLabels = '';
  ticks.forEach(function (t) {
    var y = py(t);
    grid += '<line x1="' + gutter + '" y1="' + y.toFixed(1) + '" x2="' + (gutter + plotW) + '" y2="' + y.toFixed(1) + '" stroke="' + DCOLOR.gridline + '" stroke-width="1"/>';
    ticksHtml += '<text x="' + (gutter - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="11" fill="' + DCOLOR.inkSoft + '">' + fmtCompact(t) + '</text>';
  });
  var lastI = labels.length - 1;
  labels.forEach(function (l, i) {
    var show = i === lastI || (i % labelEvery === 0 && lastI - i >= labelEvery);
    if (!show) return;
    axisLabels += '<text x="' + px(i).toFixed(1) + '" y="' + (h + 15) + '" text-anchor="middle" font-size="' + labelSize + '" font-weight="600" fill="' + DCOLOR.inkSoft + '">' + esc(l) + '</text>';
  });
  var body;
  if (!isEmpty && values.length) {
    var pts = values.map(function (v, i) { return [px(i), py(v)]; });
    var poly = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = 'M' + pts[0][0].toFixed(1) + ',' + h + ' L' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L') + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + h + ' Z';
    var gid = 'dg' + Math.random().toString(36).slice(2, 9);
    var last = pts[pts.length - 1];
    body = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<polyline points="' + poly + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4" fill="' + color + '" stroke="#fff" stroke-width="2"/>';
  } else {
    body = '<text x="' + (gutter + plotW / 2).toFixed(1) + '" y="' + (h / 2).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="600" fill="' + DCOLOR.inkSoft + '">No sales recorded yet</text>';
  }
  return '<svg viewBox="0 0 ' + w + ' ' + totalH + '" style="width:100%;height:auto;display:block;overflow:visible">' + grid + ticksHtml + body + axisLabels + '</svg>';
}

function axisBarChart(values, labels, w, h, color, isEmpty, peakLabel) {
  var ticks = niceTicks(values.length ? Math.max.apply(null, values) : 0);
  var gutter = 50, plotW = w - gutter, labelBand = 18, totalH = h + labelBand;
  var n = labels.length || 8, gap = 9;
  var barW = (plotW - gap * (n - 1)) / n;
  var hi = ticks[ticks.length - 1] || 1;
  function py(v) { return h - (v / hi) * (h - 8) - 4; }
  var grid = '', ticksHtml = '', axisLabels = '';
  ticks.forEach(function (t) {
    var y = py(t);
    grid += '<line x1="' + gutter + '" y1="' + y.toFixed(1) + '" x2="' + w + '" y2="' + y.toFixed(1) + '" stroke="' + DCOLOR.gridline + '" stroke-width="1"/>';
    ticksHtml += '<text x="' + (gutter - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="' + DCOLOR.inkSoft + '">' + fmtCompact(t) + '</text>';
  });
  labels.forEach(function (l, i) {
    var cx = gutter + i * (barW + gap) + barW / 2;
    axisLabels += '<text x="' + cx.toFixed(1) + '" y="' + (h + 13) + '" text-anchor="middle" font-size="9.5" font-weight="600" fill="' + DCOLOR.inkSoft + '">' + esc(l) + '</text>';
  });
  var bars = '', peakHtml = '', capHtml = '';
  if (!isEmpty) {
    var maxI = 0;
    values.forEach(function (v, i) { if (v > values[maxI]) maxI = i; });
    values.forEach(function (v, i) {
      var x = gutter + i * (barW + gap), y = py(v), bh = Math.max(h - y, 0), r = Math.min(4, barW / 2);
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="' + r.toFixed(1) + '" ry="' + r.toFixed(1) + '" fill="' + color + '"/>';
    });
    if (peakLabel) {
      var pxp = gutter + maxI * (barW + gap) + barW / 2, pyp = py(values[maxI]);
      peakHtml = '<text x="' + pxp.toFixed(1) + '" y="' + Math.max(pyp - 8, 12).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + color + '">' + esc(peakLabel) + '</text>';
    }
  } else {
    capHtml = '<text x="' + (gutter + plotW / 2).toFixed(1) + '" y="' + (h / 2).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="600" fill="' + DCOLOR.inkSoft + '">No sales recorded yet</text>';
  }
  return '<svg viewBox="0 0 ' + w + ' ' + totalH + '" style="width:100%;height:auto;display:block">' + grid + ticksHtml + bars + peakHtml + capHtml + axisLabels + '</svg>';
}

var DASH_BUCKET_FMT = {
  hour: function (iso) { return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', hour12: true }).replace(/\s/g, '').toLowerCase(); },
  day: function (iso) { return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' }); },
  week: function (iso, i) { return 'W' + (i + 1); },
  month: function (iso) { return new Date(iso).toLocaleDateString('en-GB', { month: 'short' }); }
};
function dashBucketLabels(trend, bucket) {
  var fn = DASH_BUCKET_FMT[bucket] || function () { return ''; };
  return trend.map(function (t, i) { return fn(t.bucket_start, i); });
}

function deltaChipHtml(total, prev, vsLabel) {
  if (!prev || prev <= 0) return '';  // no real previous period to compare: show nothing rather than an invented %
  var pct = Math.round(((total - prev) / prev) * 100);
  var up = pct >= 0;
  return '<span class="dash-chip ' + (up ? 'up' : 'down') + '">' + (up ? '↑' : '↓') + ' ' + Math.abs(pct) + '% vs ' + vsLabel + '</span>';
}
function dashDeltaText(total, prev, vsLabel) {
  if (!prev || prev <= 0) return '';
  var pct = Math.round(((total - prev) / prev) * 100);
  return (pct >= 0 ? '+' : '') + pct + '% vs ' + vsLabel;
}

// Compact header: label and value on one row so the chart starts right below.
function dashSalesGraphHtml(d) {
  var total = d ? Number(d.sales_total || 0) : 0;
  var prev = d ? Number(d.sales_prev_total || 0) : 0;
  var trend = (d && d.trend) || [];
  var values = trend.map(function (t) { return Number(t.total || 0); });
  var labels = dashBucketLabels(trend, d ? d.bucket : 'day');
  var isEmpty = total <= 0;
  var chip = isEmpty ? '' : deltaChipHtml(total, prev, DASH_VS_LABEL[dashRange]);
  var periodLabel = (DASH_PERIOD_LABEL[dashRange] || 'Today').toLowerCase();
  return '<div class="dash-card-head"><div class="t">Sales &mdash; ' + esc(periodLabel) + '</div><div class="v">' + fmt(total) + '</div></div>' +
    (chip ? '<div class="dash-graph-chip-row">' + chip + '</div>' : '') +
    '<div class="dash-chart-wrap">' + axisLineChart(values, labels, dashChartW(), dashChartW() > 640 ? 180 : 140, DCOLOR.salesLine, isEmpty) + '</div>';
}

function dashRushGraphHtml(d) {
  var rushRows = (d && d.rush) || [];
  var values = [0, 0, 0, 0, 0, 0, 0, 0];
  rushRows.forEach(function (r) { if (r.idx >= 0 && r.idx < 8) values[r.idx] = Number(r.total || 0); });
  var totalRush = values.reduce(function (a, v) { return a + v; }, 0);
  var isEmpty = totalRush <= 0;
  var maxI = 0;
  values.forEach(function (v, i) { if (v > values[maxI]) maxI = i; });
  var headline = isEmpty ? '—' : RUSH_LABELS[maxI];
  var share = isEmpty ? 0 : Math.round((values[maxI] / totalRush) * 100);
  var chip = isEmpty ? '' : '<span class="dash-chip" style="color:' + DCOLOR.violet + '">' + share + '% of sales in this window</span>';
  return '<div class="dash-graph-head"><div class="section-title" style="text-align:center">Rush hours</div>' +
    '<div class="dash-graph-headline">' + esc(headline) + '</div>' +
    '<div class="dash-graph-chip-row">' + chip + '</div>' +
    '<div class="dash-chart-wrap">' + axisBarChart(values, RUSH_LABELS, 600, 140, DCOLOR.violet, isEmpty, isEmpty ? null : 'Peak: ' + RUSH_LABELS[maxI]) + '</div>' +
  '</div>';
}

// Stat tiles: 2 across (4 on desktop). Sales and Profit first, then Stock value
// and Supplier debt. Each tile is tinted in its own colour.
function dashStatGridHtml(d, snap) {
  snap = snap || {};
  var salesTotal = d ? Number(d.sales_total || 0) : 0;
  var profitTotal = d ? Number(d.profit_total || 0) : 0;
  var profitPrev = d ? Number(d.profit_prev_total || 0) : 0;
  var marginPct = salesTotal > 0 ? Math.round((profitTotal / salesTotal) * 100) : null;

  var stats = [
    { label: 'Sales', value: fmt(salesTotal), color: DCOLOR.sales, bg: DCOLOR.salesLight,
      sub: dashDeltaText(salesTotal, d ? d.sales_prev_total : 0, DASH_VS_LABEL[dashRange]) || DASH_PERIOD_LABEL[dashRange] },
    { label: 'Profit', value: fmt(profitTotal), color: DCOLOR.sales, bg: DCOLOR.salesLight,
      sub: marginPct === null ? 'No sales yet' : (dashDeltaText(profitTotal, profitPrev, DASH_VS_LABEL[dashRange]) || (marginPct + '% margin')) },
    { label: 'Stock value', value: fmt(snap.stockValue || 0), color: DCOLOR.orange, bg: DCOLOR.orangeLight,
      sub: (snap.drugCount || 0) + ' drugs tracked' },
    { label: 'Debt owed', value: fmt(snap.supplierOwed || 0), color: DCOLOR.magenta, bg: DCOLOR.magentaLight,
      sub: (snap.suppliersOwedCount || 0) + ((snap.suppliersOwedCount || 0) === 1 ? ' supplier' : ' suppliers') }
  ];
  return stats.map(function (p) {
    return '<div class="dash-stat" style="background:' + p.bg + ';border-color:' + p.color + '">' +
      '<div class="lab" style="color:' + p.color + '">' + esc(p.label) + '</div>' +
      '<div class="val">' + p.value + '</div>' +
      '<div class="sub">' + esc(p.sub) + '</div>' +
    '</div>';
  }).join('');
}

function segmentedBarHtml(segments, h) {
  var total = segments.reduce(function (a, s) { return a + s[0]; }, 0) || 1;
  var parts = segments.map(function (s) {
    var pct = s[0] / total * 100;
    return '<div style="width:' + pct.toFixed(2) + '%;background:' + s[1] + '"></div>';
  }).join('');
  return '<div style="display:flex;width:100%;height:' + h + 'px;border-radius:' + (h / 2) + 'px;overflow:hidden;background:var(--line)">' + parts + '</div>';
}

// Stock health header, with the Out / Low / Healthy legend as a fixed 3-column
// grid so all three sit on one line on a phone.
function dashStockHealthHtml(snap) {
  snap = snap || {};
  var out = (snap.outOfStock || []).length, low = (snap.lowStock || []).length;
  var total = snap.drugCount || 0;
  var healthy = Math.max(total - out - low, 0);
  var hasData = total > 0;
  var bar = hasData
    ? segmentedBarHtml([[out, DCOLOR.critical], [low, DCOLOR.warning], [healthy, DCOLOR.good]], 10)
    : '<div style="height:10px;border-radius:5px;background:var(--line)"></div>';
  var legend = '<div class="dash-health-legend">' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.critical + '"></span>Out ' + out + '</span>' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.warning + '"></span>Low ' + low + '</span>' +
    '<span class="sw"><span class="dot" style="background:' + DCOLOR.good + '"></span>Healthy ' + healthy + '</span>' +
  '</div>';
  var caption = hasData ? '' : '<div class="tiny" style="margin-top:8px">No drugs added yet — add your first drug in Inventory to start tracking stock health.</div>';
  return '<div class="dash-card-head"><div class="t">Stock health</div><div class="v" style="font-size:12.5px;color:var(--ink-soft);font-weight:700">' + total + ' drugs</div></div>' +
    '<div style="height:8px"></div>' + bar + legend + caption;
}

function dashProfitHtml(d) {
  var sales = d ? Number(d.sales_total || 0) : 0;
  var cost = d ? Number(d.cost_total || 0) : 0;
  var profit = d ? Number(d.profit_total || 0) : 0;
  var hasData = sales > 0;
  var marginPct = hasData ? Math.round((profit / sales) * 100) : 0;
  var bar = hasData
    ? segmentedBarHtml([[Math.max(cost, 0), DCOLOR.ctxWarm], [Math.max(profit, 0), DCOLOR.sales]], 14)
    : '<div style="height:14px;border-radius:7px;background:var(--line)"></div>';
  var legend = hasData
    ? '<div class="dash-profit-legend">' +
      '<span class="sw"><span class="dot" style="background:' + DCOLOR.ctxWarm + '"></span>Cost of goods <b>' + fmt(cost) + '</b></span>' +
      '<span class="sw"><span class="dot" style="background:' + DCOLOR.sales + '"></span>Profit <b>' + fmt(profit) + '</b></span>' +
      '<span class="dash-profit-margin">' + marginPct + '% margin</span>' +
    '</div>'
    : '<div class="tiny" style="margin-top:8px">No sales recorded yet for this period.</div>';
  var header = '<div style="display:flex;align-items:baseline;justify-content:space-between">' +
    '<div class="section-title">Sales &rarr; cost &rarr; profit</div>' +
    '<div class="tiny">Sales ' + fmt(sales) + '</div></div>';
  return header + '<div style="height:10px"></div>' + bar + legend;
}

function dashBarRowHtml(label, valueTxt, pct, color) {
  pct = Math.max(4, Math.min(100, pct));
  return '<div class="dash-bar-row">' +
    '<div class="dash-bar-label">' + esc(label) + '</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<div class="dash-bar-value">' + esc(valueTxt) + '</div>' +
  '</div>';
}
function dashPlaceholderRowHtml() {
  return '<div class="dash-bar-row placeholder">' +
    '<div class="dash-bar-label">—</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:4%;background:var(--line)"></div></div>' +
    '<div class="dash-bar-value">—</div>' +
  '</div>';
}
function dashUrgencyRowHtml(name, meta, daysTxt, pct, kind) {
  var color = { critical: DCOLOR.critical, serious: DCOLOR.serious, warning: DCOLOR.warning }[kind];
  var word = { critical: 'Critical', serious: 'Soon', warning: 'Watch' }[kind];
  pct = Math.max(6, Math.min(100, pct));
  return '<div class="dash-bar-row">' +
    '<div style="width:150px;min-width:0">' +
      '<div class="dash-bar-label" style="width:auto">' + esc(name) + '</div>' +
      '<div class="dash-bar-meta">' + esc(meta) + '</div>' +
    '</div>' +
    '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<div class="dash-bar-value" style="width:34px">' + esc(daysTxt) + '</div>' +
    '<div class="dash-bar-status ' + kind + '">' + word + '</div>' +
  '</div>';
}

function dashTopSellersCard(d) {
  var all = (d && d.top_sellers) || [];
  var top4 = all.slice(0, 4);
  var maxUnits = top4.length ? Math.max.apply(null, top4.map(function (s) { return Number(s.units || 0); })) : 1;
  var rows = top4.map(function (s) {
    var pct = maxUnits ? (Number(s.units || 0) / maxUnits * 100) : 0;
    return dashBarRowHtml(s.name, Number(s.units || 0) + ' units', pct, DCOLOR.blue);
  }).join('');
  for (var i = top4.length; i < 4; i++) rows += dashPlaceholderRowHtml();
  var empty = all.length === 0 ? '<div class="tiny" style="text-align:center;margin-top:14px">No sales recorded yet this period.</div>' : '';
  var footer = all.length > 4 ? '<button class="dash-view-all" onclick="openTopSellersFull()">View all ' + all.length + ' &rarr;</button>' : '';
  // Plain white card with a compact left-aligned header.
  return '<div class="card dash-list-card t-blue"><div class="dash-card-head"><div class="t">' + esc(DASH_TOPSELLERS_TITLE[dashRange] || 'Top sellers') + '</div></div>' + rows + empty + footer + '</div>';
}

function dashExpiringCard(snap) {
  var all = (snap && snap.expiring) || [];
  var top4 = all.slice(0, 4);
  var rows = top4.map(function (b) {
    var days = daysUntil(b.expiry_date);
    var kind = days <= 14 ? 'critical' : days <= 30 ? 'serious' : 'warning';
    var pct = Math.max(6, Math.min(100, 100 - Math.min(days, 90) / 90 * 100));
    return dashUrgencyRowHtml(b.drug_name, 'batch ' + (b.batch_no || '—') + ' · ' + qtyUnit(b.quantity_remaining, b.unit), days + 'd', pct, kind);
  }).join('');
  for (var i = top4.length; i < 4; i++) rows += dashPlaceholderRowHtml();
  var empty = all.length === 0 ? '<div class="tiny" style="text-align:center;margin-top:14px">Nothing expiring soon.</div>' : '';
  var footer = all.length > 4 ? '<button class="dash-view-all" onclick="openExpiringFull()">View all ' + all.length + ' &rarr;</button>' : '';
  return '<div class="card dash-list-card t-red"><div class="dash-card-head"><div class="t">Expiring soon</div></div>' + rows + empty + footer + '</div>';
}

function openTopSellersFull() {
  var all = (dashData && dashData.top_sellers) || [];
  var maxUnits = all.length ? Math.max.apply(null, all.map(function (s) { return Number(s.units || 0); })) : 1;
  var body = '<div class="card">' + (all.length ? all.map(function (s) {
    var pct = maxUnits ? Number(s.units || 0) / maxUnits * 100 : 0;
    return dashBarRowHtml(s.name, Number(s.units || 0) + ' units · ' + fmt(s.revenue), pct, DCOLOR.blue);
  }).join('') : '<div class="empty">No sales recorded yet this period.</div>') + '</div>';
  sheet((DASH_TOPSELLERS_TITLE[dashRange] || 'Top sellers') + ' — full list', body);
}

function openExpiringFull() {
  var all = (dashSnap && dashSnap.expiring) || [];
  var body = '<div class="card">' + (all.length ? all.map(function (b) {
    var days = daysUntil(b.expiry_date);
    var kind = days <= 14 ? 'critical' : days <= 30 ? 'serious' : 'warning';
    var pct = Math.max(6, Math.min(100, 100 - Math.min(days, 90) / 90 * 100));
    return dashUrgencyRowHtml(b.drug_name, 'batch ' + (b.batch_no || '—') + ' · ' + qtyUnit(b.quantity_remaining, b.unit), days + 'd', pct, kind);
  }).join('') : '<div class="empty">Nothing expiring soon.</div>') + '</div>';
  sheet('Expiring soon — full list', body);
}

function kpi(label, value, kind) {
  return '<div class="kpi ' + (kind || '') + '"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div></div>';
}
function listRow(name, meta, right) {
  return '<div class="list-row"><div><div class="name">' + esc(name) + '</div><div class="meta">' + meta + '</div></div><div class="right">' + right + '</div></div>';
}

