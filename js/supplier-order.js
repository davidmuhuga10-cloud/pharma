// js/supplier-order.js - order low-stock drugs from a supplier by WhatsApp.
//
// Opened from the Low Stock (Reorder List) report. The person picks a supplier, ticks the drugs and
// quantities, reads the message, and a WhatsApp chat opens with the message already written. The
// message is sent from the person's own WhatsApp; nothing is sent by the app and nothing is saved.
// A drug is ticked for a supplier when that supplier delivered its most recent batch.

var soRows = [];          // low-stock rows being ordered: { drug_id, name, unit, suggested, supplier_id }
var soMessageEdited = false;

// A phone number as a supplier would have it typed ("0712 345 678", "+254 712 345 678", "254712345678")
// turned into the digits WhatsApp wants (254712345678). null when it does not look like a phone number.
function supplierWaPhone(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  var plus = s.charAt(0) === '+';
  var d = s.replace(/\D/g, '');
  if (!d) return null;
  if (plus) return d.length >= 11 && d.length <= 15 ? d : null;
  if (d.indexOf('00') === 0) { d = d.slice(2); return d.length >= 11 && d.length <= 15 ? d : null; }
  if (d.charAt(0) === '0' && d.length === 10 && (d.charAt(1) === '7' || d.charAt(1) === '1')) return '254' + d.slice(1);
  if (d.indexOf('254') === 0 && d.length === 12) return d;
  if (d.length === 9 && (d.charAt(0) === '7' || d.charAt(0) === '1')) return '254' + d;
  return null;
}

// lines: [{ name, qty, unit }]. Plain text, one drug per line, ready to edit before sending.
function supplierOrderMessage(pharmacyName, supplierName, lines) {
  var out = 'Hello' + (supplierName ? ' ' + supplierName : '') + ', this is ' + (pharmacyName || 'our pharmacy') + '. Please supply:\n';
  lines.forEach(function (l, i) { out += (i + 1) + '. ' + l.name + ' - ' + qtyUnit(l.qty, l.unit) + '\n'; });
  out += 'Please confirm what is available and the price. Thank you.';
  return out;
}

function supplierOrderLink(phone, text) {
  return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text);
}

// The most recent supplier of each drug, from its batches. { drug_id: supplier_id }
async function loadLastSuppliers(drugIds) {
  var map = {};
  if (!drugIds.length) return map;
  try {
    var r = await sb.from('batches').select('drug_id, supplier_id, received_at').in('drug_id', drugIds)
      .not('supplier_id', 'is', null).order('received_at', { ascending: false }).limit(3000);
    (r.data || []).forEach(function (b) { if (!map[b.drug_id]) map[b.drug_id] = b.supplier_id; });
  } catch (e) { /* without this the person just ticks the drugs themselves */ }
  return map;
}

async function openSupplierOrder() {
  if (!lowStockReportData || !lowStockReportData.rows.length) { toast('Nothing to order right now.', 'bad'); return; }
  var sups = STATE.suppliersCache || [];
  if (!sups.length) { toast('Add a supplier first under Suppliers.', 'bad'); return; }
  var last = await loadLastSuppliers(lowStockReportData.rows.map(function (r) { return r.drug_id; }).filter(Boolean));
  soRows = lowStockReportData.rows.map(function (r) {
    return { drug_id: r.drug_id, name: r.name, unit: r.unit, suggested: r.suggested, supplier_id: last[r.drug_id] || null };
  });
  soMessageEdited = false;
  var body = sheet('Order by WhatsApp', '');
  body.innerHTML =
    '<div class="field"><label>Supplier</label><select id="soSupplier" onchange="soPickSupplier()">' +
    '<option value="">Choose the supplier</option>' +
    sups.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + (supplierWaPhone(s.phone) ? '' : ' (no phone)') + '</option>'; }).join('') +
    '</select></div>' +
    '<div id="soList"></div>' +
    '<div class="field"><label>Message</label><textarea id="soMsg" rows="8" oninput="soMessageEdited=true;soRefreshLink()"></textarea></div>' +
    '<div id="soNote" class="tiny" style="margin-bottom:8px"></div>' +
    '<div id="soActions"></div>';
  soDrawList(null);
  soRefresh();
}

// Drugs last bought from the chosen supplier come first and are ticked; if none were, all are ticked.
function soPickSupplier() {
  var sid = $('#soSupplier').value || null;
  soDrawList(sid);
  soMessageEdited = false;
  soRefresh();
}

function soDrawList(supplierId) {
  var any = supplierId && soRows.some(function (r) { return r.supplier_id === supplierId; });
  var order = soRows.map(function (r, i) { return i; });
  if (any) order.sort(function (a, b) { return (soRows[a].supplier_id === supplierId ? 0 : 1) - (soRows[b].supplier_id === supplierId ? 0 : 1) || a - b; });
  $('#soList').innerHTML = '<div class="card" style="max-height:260px;overflow:auto;margin-bottom:10px">' + order.map(function (i) {
    var r = soRows[i];
    var ticked = !supplierId || !any || r.supplier_id === supplierId;
    return '<div class="list-row"><label style="display:flex;gap:8px;align-items:center;flex:1;min-width:0">' +
      '<input type="checkbox" id="soChk' + i + '"' + (ticked ? ' checked' : '') + ' onchange="soMessageEdited=false;soRefresh()">' +
      '<span class="name">' + esc(r.name) + '</span></label>' +
      '<div class="right"><input type="number" min="1" id="soQty' + i + '" value="' + Number(r.suggested) + '" style="width:72px" oninput="soMessageEdited=false;soRefresh()"> <span class="tiny">' + esc(r.unit) + '</span></div></div>';
  }).join('') + '</div>';
}

// The drugs ticked, with a valid whole quantity.
function soChosenLines() {
  var lines = [];
  soRows.forEach(function (r, i) {
    var chk = $('#soChk' + i), q = $('#soQty' + i);
    if (!chk || !chk.checked) return;
    var n = parseInt(q.value, 10);
    if (n > 0) lines.push({ name: r.name, qty: n, unit: r.unit });
  });
  return lines;
}

function soRefresh() {
  var sid = $('#soSupplier').value;
  var sup = (STATE.suppliersCache || []).find(function (s) { return s.id === sid; });
  if (!soMessageEdited) {
    var lines = soChosenLines();
    $('#soMsg').value = lines.length ? supplierOrderMessage(STATE.pharmacy && STATE.pharmacy.name, sup && sup.name, lines) : '';
  }
  soRefreshLink();
}

function soRefreshLink() {
  var sid = $('#soSupplier').value;
  var sup = (STATE.suppliersCache || []).find(function (s) { return s.id === sid; });
  var text = $('#soMsg').value.trim();
  var phone = sup ? supplierWaPhone(sup.phone) : null;
  var note = '';
  var wa = '';
  if (!sup) note = 'Choose the supplier to open WhatsApp.';
  else if (!phone) note = 'This supplier has no phone number the app can use. Add it under Suppliers, or copy the message and send it yourself.';
  else if (!text) note = 'Tick at least one drug.';
  else if (supplierOrderLink(phone, text).length > 3500) note = 'This message is very long and may not open in WhatsApp. Copy it instead, or order fewer drugs at a time.';
  if (sup && phone && text) {
    wa = '<a class="btn primary" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px" target="_blank" rel="noopener" href="' + esc(supplierOrderLink(phone, text)) + '">Open WhatsApp</a>';
  }
  $('#soNote').textContent = note;
  $('#soActions').innerHTML = wa + (text ? '<button class="btn secondary block" onclick="soCopy()">Copy message</button>' : '');
}

async function soCopy() {
  var text = $('#soMsg').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    var t = $('#soMsg'); t.select();
    try { document.execCommand('copy'); } catch (e2) { toast('Press and hold the message, then copy it.', 'bad'); return; }
  }
  toast('Message copied.', 'good');
}
