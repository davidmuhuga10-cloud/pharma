// js/export.js - printing, Excel export and the shared report table helpers.
//
// Every report screen looks the same: filter tiles or a date-range bar on top,
// a table showing 10 rows at a time with Prev/Next, plain coloured status text,
// and Excel + Print buttons. Print and Excel always carry the WHOLE filtered
// list, never just the page on screen. The helpers below build those pieces.

// ---- paging ----
var REPORT_PAGE_SIZE = 10;

// One page of an already-filtered list. `page` is clamped, so a list that
// shrank (a row saved, a filter changed) never leaves you on an empty page.
function pageSlice(rows, page) {
  var size = REPORT_PAGE_SIZE, total = rows.length;
  var pages = Math.max(1, Math.ceil(total / size));
  var p = Math.min(Math.max(1, Number(page) || 1), pages);
  return {
    rows: rows.slice((p - 1) * size, p * size), page: p, pages: pages, total: total,
    from: total ? (p - 1) * size + 1 : 0, to: Math.min(p * size, total)
  };
}

// "Showing 1–10 of 20", the line above a table.
function showingHtml(pg) {
  return '<div class="rt-count">' + (pg.total ? 'Showing ' + pg.from + '–' + pg.to + ' of ' + pg.total : 'Nothing to show') + '</div>';
}

// The page numbers to offer: all of them for a short list, otherwise the first, the last
// and the ones around the current page, with "..." where pages are skipped.
function pageNumbers(page, pages) {
  if (pages <= 7) { var all = []; for (var i = 1; i <= pages; i++) all.push(i); return all; }
  var out = [1];
  var from = Math.max(2, page - 1), to = Math.min(pages - 1, page + 1);
  if (from > 2) out.push('…');
  for (var n = from; n <= to; n++) out.push(n);
  if (to < pages - 1) out.push('…');
  out.push(pages);
  return out;
}

// Prev, numbered pages, "Page 2 of 5", Next. `fn` is the NAME of a global function that
// receives the page number to show. Nothing is drawn when everything fits on one page.
// On a phone the numbers are hidden and "Page 2 of 5" sits between Prev and Next.
function pagerHtml(pg, fn) {
  if (pg.pages <= 1) return '';
  return '<div class="pager">' +
    '<button class="pg-btn" ' + (pg.page <= 1 ? 'disabled' : 'onclick="' + fn + '(' + (pg.page - 1) + ')"') + '>&lsaquo; Prev</button>' +
    '<div class="pg-info">Page ' + pg.page + ' of ' + pg.pages + '</div>' +
    '<div class="pg-nums">' + pageNumbers(pg.page, pg.pages).map(function (n) {
      return n === '…' ? '<span class="pg-gap">…</span>' : '<button class="pg-num' + (n === pg.page ? ' on' : '') + '" onclick="' + fn + '(' + n + ')">' + n + '</button>';
    }).join('') + '</div>' +
    '<button class="pg-btn primary" ' + (pg.page >= pg.pages ? 'disabled' : 'onclick="' + fn + '(' + (pg.page + 1) + ')"') + '>Next &rsaquo;</button>' +
    '</div>';
}

// ---- cells ----
// A cell is plain text (escaped for you), a number, or an object:
//   { t: 'Expired', c: 'st-bad' }   text with a colour class (st-bad / st-warn / st-ok)
//   { html: '<b>x</b>' }            markup you have already escaped
// Status is only ever coloured text, never a badge with a background.
function stCell(text, tone) { return { t: text, c: 'st-' + tone }; }

function cellText(c) {
  if (c == null) return '';
  if (typeof c === 'object') return c.html != null ? String(c.html).replace(/<[^>]*>/g, '') : (c.t == null ? '' : String(c.t));
  return String(c);
}
var NUMERIC_CELL = /^(KES\s)?[-+–]?\s?[\d,]+(\.\d+)?%?$/;

// A column is right-aligned when every filled cell in it is a number or a KES amount.
function numericColumns(rows, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var any = false, all = true;
    for (var r = 0; r < rows.length; r++) {
      var v = cellText(rows[r][i]).trim();
      if (v === '' || v === '—' || v === '–') continue;   // "nothing here" dashes do not stop a number column
      any = true;
      if (!NUMERIC_CELL.test(v)) { all = false; break; }
    }
    out.push(any && all);
  }
  return out;
}

function cellInner(c) {
  if (c == null) return '';
  if (typeof c === 'object') {
    if (c.html != null) return c.html;
    return '<span class="' + esc(c.c || '') + '">' + esc(c.t == null ? '' : String(c.t)) + '</span>';
  }
  return esc(String(c));
}

// The on-screen table. cols: ['Drug', 'Qty', ...] (strings). rows: arrays of cells.
// opts.rowClick(i) returns an onclick string for row i of THESE rows; opts.num
// can force which columns are right-aligned. On a phone each row becomes a small
// card: the first cell is the title and the rest keep their column label (data-label).
function rtTable(cols, rows, opts) {
  opts = opts || {};
  var num = opts.num || numericColumns(rows, cols.length);
  return '<div class="rt-wrap"><table class="rt"><thead><tr>' +
    cols.map(function (h, i) { return '<th' + (num[i] ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    (rows.length ? rows.map(function (r, ri) {
      var click = opts.rowClick ? opts.rowClick(ri) : '';
      return '<tr' + (click ? ' class="rt-click" onclick="' + click + '"' : '') + '>' + cols.map(function (h, i) {
        return '<td data-label="' + esc(h) + '"' + (num[i] ? ' class="num"' : '') + '>' + cellInner(r[i]) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td class="rt-empty" colspan="' + cols.length + '">' + esc(opts.empty || 'Nothing to show.') + '</td></tr>') +
    '</tbody></table></div>';
}

// ---- date range ----
// Both dates are 'YYYY-MM-DD'. Returns '' when fine, otherwise the message to show.
function rangeError(from, to) {
  if (!from || !to) return 'Pick both a from and a to date.';
  if (from > to) return 'The "from" date must be before the "to" date.';
  return '';
}

// The database wants a start and an END THAT IS NOT INCLUDED, in the device's
// own time: midnight at the start of `from` up to midnight after `to`.
function rangeBounds(from, to) {
  var f = from.split('-'), t = to.split('-');
  var start = new Date(+f[0], +f[1] - 1, +f[2], 0, 0, 0, 0);
  var end = new Date(+t[0], +t[1] - 1, +t[2] + 1, 0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

// The bar above a report: quick ranges plus From / To / Apply.
//   o.presets [{key,label}], o.active (a preset key, or 'custom'), o.from, o.to
//   o.pickFn  name of a function taking the preset key
//   o.applyFn name of a function called with no arguments (it reads rangeBarRead())
function rangeBarHtml(o) {
  return '<div class="range-bar">' +
    '<div class="dash-tabs">' + (o.presets || []).map(function (p) {
      return '<button class="dash-tab' + (o.active === p.key ? ' active' : '') + '" onclick="' + o.pickFn + '(\'' + p.key + '\')">' + esc(p.label) + '</button>';
    }).join('') + '</div>' +
    '<div class="range-dates">' +
    '<label>From <input type="date" id="rbFrom" value="' + esc(o.from || '') + '"></label>' +
    '<label>To <input type="date" id="rbTo" value="' + esc(o.to || '') + '"></label>' +
    '<button class="btn small' + (o.active === 'custom' ? ' primary' : '') + '" onclick="' + o.applyFn + '()">Apply</button>' +
    '</div></div>';
}
function rangeBarRead() {
  return { from: $('#rbFrom') ? $('#rbFrom').value : '', to: $('#rbTo') ? $('#rbTo').value : '' };
}

// The title / Excel / Print row every report screen starts with.
function reportHeadHtml(title, excelFn, printFn) {
  // The owner can switch Excel and Print off for one person (permission "export").
  var okExcel = typeof can !== 'function' || can('export');
  var okPrint = typeof can !== 'function' || can('print');
  return '<div class="report-head"><div class="section-title" style="margin:0">' + esc(title) + '</div>' +
    '<div class="toolbar-segment">' +
    (excelFn && okExcel ? '<button class="btn" onclick="' + excelFn + '()">' + icon('download', 15) + ' Excel</button>' : '') +
    (printFn && okPrint ? '<button class="btn" onclick="' + printFn + '()">' + icon('printer', 15) + ' Print</button>' : '') +
    '</div></div>';
}

// ---- printing ----

// The letterhead. A report gets a business-letter head: the pharmacy's name, address, contacts and KRA PIN
// on the left, the report title and its period on the right, then a double rule (see "LETTERHEAD" in
// style.css). A receipt keeps the plain centred head that fits an 80mm roll.
// Self-contained on purpose (only esc and STATE).
function letterheadHtml(title, subtitle, receipt) {
  var p = STATE.pharmacy || {};
  var metaLines = [p.address, [p.town, p.phone].filter(Boolean).join(' · '), p.email].filter(Boolean);
  var full = esc(title) + (subtitle ? ' — ' + esc(subtitle) : '');
  if (receipt) {
    return '<div class="print-letterhead">' +
      '<div class="pname">' + esc(p.name || '') + '</div>' +
      metaLines.map(function (m) { return '<div class="pmeta">' + esc(m) + '</div>'; }).join('') +
      '</div>' +
      '<div class="print-title">' + full + '</div>';
  }
  // Name and contacts left, title and period right. Every line is optional: a pharmacy that only filled in
  // its name in Settings still gets a tidy head, with no empty lines or stray separators. The KRA PIN is
  // printed on reports (not on the till receipt) when the owner has entered one.
  var lines = metaLines.concat(p.kra_pin ? ['KRA PIN: ' + p.kra_pin] : []);
  return '<div class="print-letterhead">' +
    '<div class="plh-left"><div class="pname">' + esc(p.name || '') + '</div>' +
    lines.map(function (m) { return '<div class="pmeta">' + esc(m) + '</div>'; }).join('') + '</div>' +
    '<div class="print-titlebar"><span class="print-ribbon">' + esc(title) + '</span>' +
    (subtitle ? '<div class="print-period">' + esc(subtitle) + '</div>' : '') + '</div>' +
    '</div><div class="plh-line"></div>';
}

// Sets the text drawn at the bottom-left of every printed page ("Afya Bora Chemist · Generated by Pharma") by
// writing a small @page rule. Empty text clears it (a receipt has no footer here). The text is put inside a CSS
// string, so backslashes, quotes and line breaks are neutralised first: a pharmacy name containing a quote
// must not be able to break out of the string. No document (the unit tests) means nothing to do.
function setPrintPageFooter(text) {
  if (typeof document === 'undefined' || !document.head) return;
  var st = document.getElementById('printPageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.appendChild(st); }
  var t = String(text || '').replace(/[\\"]/g, '\\$&').replace(/[\r\n\u2028\u2029]+/g, ' ');
  st.textContent = t ? '@page { @bottom-left { content: "' + t + '"; font: 9px Arial, sans-serif; color: #000; } }' : '';
}

// opts.receipt: true prints at 80mm (a thermal till roll) instead of a full page -
// see the "80mm thermal till roll" note in style.css. The class is set fresh on every
// call, so a receipt never leaves the next ordinary report printing narrow by mistake.
function printHtml(title, subtitle, bodyHtml, footNote, opts) {
  var area = $('#printArea');
  var receipt = !!(opts && opts.receipt);
  var when = new Date().toLocaleString('en-GB');
  area.className = 'print-only' + (receipt ? ' print-receipt' : '');
  if (receipt) {
    area.innerHTML = letterheadHtml(title, subtitle, true) + bodyHtml +
      '<div class="print-footer">' + (footNote ? esc(footNote) + ' · ' : '') +
      'Printed ' + when + ' · Generated by Pharma</div>';
  } else {
    var by = (STATE.profile && STATE.profile.full_name) || '';
    area.innerHTML = letterheadHtml(title, subtitle, false) +
      '<div class="print-meta"><span>Printed ' + esc(when) + (by ? ' · by ' + esc(by) : '') + '</span>' + (footNote ? '<span>' + esc(footNote) + '</span>' : '') + '</div>' +
      bodyHtml;
  }
  // The footer lives in the page margin, not in the report, so it repeats on every page and cannot be stranded.
  // A very long pharmacy name is shortened here (the letterhead above still shows it in full): in the narrow
  // margin of a small page a long footer pushed the page number out altogether (seen on A5).
  var pharmName = (STATE.pharmacy && STATE.pharmacy.name) || '';
  var footName = pharmName.length > 48 ? pharmName.slice(0, 47) + '…' : pharmName;
  setPrintPageFooter(receipt ? '' : (footName ? footName + ' · ' : '') + 'Generated by Pharma');
  setTimeout(function () { window.print(); }, 30);
}

// "KES 16,422" wrapped on paper with KES above the number. Printed money columns therefore show the plain
// number and the currency once in the column heading: "Value (KES)". A column that mixes money with words
// ("Owes KES 500", "Settled") is left exactly as it is.
var MONEY_CELL = /^([A-Z]{3}) (-?[\d,]+(?:\.\d+)?)$/;
function moneyColumn(rows, i) {
  var cur = null, seen = 0;
  for (var r = 0; r < rows.length; r++) {
    var c = rows[r][i];
    if (c != null && typeof c === 'object' && c.html != null) return null;
    var t = cellText(c).trim();
    if (!t || t === '—' || t === '–' || t === '-') continue;
    var m = MONEY_CELL.exec(t);
    if (!m || (cur && m[1] !== cur)) return null;
    cur = m[1]; seen++;
  }
  return seen ? cur : null;
}
function stripMoney(c) {
  if (c != null && typeof c === 'object') return { t: String(c.t).replace(MONEY_CELL, '$2'), c: c.c };
  return String(c == null ? '' : c).trim().replace(MONEY_CELL, '$2');
}
function withCurrency(h, cur) { return /\)$/.test(h) ? h.slice(0, -1) + ', ' + cur + ')' : h + ' (' + cur + ')'; }

// The printed table: a # column, plain black lines, numbers right-aligned, one line per row.
// `foot` (optional) is one total line under the table.
function tableHtml(headers, rows, foot) {
  var cur = headers.map(function (h, i) { return moneyColumn(rows, i); });
  var heads = headers.map(function (h, i) { return cur[i] ? withCurrency(h, cur[i]) : h; });
  var body = rows.map(function (r) { return r.map(function (c, i) { return cur[i] && i < headers.length ? stripMoney(c) : c; }); });
  var num = numericColumns(body, headers.length);
  function rowHtml(r, ri, cls) {
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td class="no">' + (ri + 1) + '</td>' + headers.map(function (h, i) {
      return '<td' + (num[i] ? ' class="num"' : '') + '>' + cellInner(r[i]) + '</td>';
    }).join('') + '</tr>';
  }
  // With a total line, the LAST data row goes inside the <tfoot> beside it, so the two are one unbreakable block
  // and the total can never be left alone at the top of a new page (see ".print-table tfoot" in style.css).
  var keepLast = !!foot && body.length > 0;
  var main = keepLast ? body.slice(0, -1) : body;
  return '<table class="print-table' + (headers.length > 7 ? ' wide' : '') + '"><thead><tr><th class="no">#</th>' +
    heads.map(function (h, i) { return '<th' + (num[i] ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    main.map(function (r, ri) { return rowHtml(r, ri); }).join('') + '</tbody>' +
    (foot ? '<tfoot>' + (keepLast ? rowHtml(body[body.length - 1], body.length - 1, 'lastrow') : '') +
      '<tr><td colspan="' + (headers.length + 1) + '">' + esc(foot) + '</td></tr></tfoot>' : '') +
    '</table>';
}

function exportExcel(filename, sheetName, rows) {
  if (!rows.length) { toast('Nothing to export.', 'bad'); return; }
  var write = function () {
    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
    XLSX.writeFile(wb, filename);
  };
  if (window.XLSX) { write(); return; }
  toast('Preparing Excel file…');
  loadXlsx().then(write).catch(function (e) { toast(friendlyError(e), 'bad'); });
}
