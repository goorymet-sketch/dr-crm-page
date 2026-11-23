/**
 * Digital Reach CRM — تنبيهات على الإيميل + جوجل كالندر
 * الـ CRM بيبعت المواعيد هنا كل ما تحفظ.
 * كل 10 دقايق: إيميل قبل كل متابعة بـ 15 دقيقة + بيحط المواعيد في جوجل كالندر بتنبيه.
 * كل يوم الساعة 9 الصبح: إيميل بملخص اليوم.
 * التركيب: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 */

var REMIND_BEFORE_MIN = 15;
var CAL_POPUPS = [15, 60];   // تنبيهات الكالندر قبل الميعاد بالدقايق
var CAL_DAYS_AHEAD = 60;
var P = PropertiesService.getScriptProperties();

/* ===== استقبال المواعيد من الـ CRM ===== */
function doPost(e) {
  var body = JSON.parse(e.postData.contents || '{}');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureTriggers_();
    if (body.tz) P.setProperty('tz', body.tz);
    if (body.crmUrl) P.setProperty('crmUrl', body.crmUrl);
    if (body.items) putJson_('rem', body.items);
    if (body.test) sendTest_();
    syncCal_(getJson_('rem', []));
  } finally { lock.releaseLock(); }
  return ContentService.createTextOutput('ok');
}
function doGet() {
  ensureTriggers_();
  return ContentService.createTextOutput('Digital Reach CRM reminders: شغال ✓');
}

/* ===== كل 10 دقايق ===== */
function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var items = getJson_('rem', []), sent = getJson_('sent', {}), now = new Date();
    var soon = now.getTime() + REMIND_BEFORE_MIN * 60000, old = now.getTime() - 2 * 3600000;
    var due = [], missed = 0;
    items.forEach(function (it) {
      var t = new Date(it.due).getTime();
      if (isNaN(t) || t > soon || sent[it.key]) return;
      if (t >= old) due.push(it); else missed++;
      sent[it.key] = now.toISOString();
    });
    if (due.length) {
      var subj = due.length === 1 ? '🔔 متابعة: ' + due[0].title : '🔔 عندك ' + due.length + ' متابعات دلوقتي';
      mail_(subj, due.map(itemHtml_).join('<hr>') + footer_());
    }
    if (missed) mail_('⚠️ ' + missed + ' متابعة فاتت', 'افتح تاب المتابعة في الـ CRM.' + footer_());
    var cut = new Date(now.getTime() - 30 * 86400000).toISOString(), clean = {};
    for (var k in sent) if (sent[k] >= cut) clean[k] = sent[k];
    putJson_('sent', clean);
    syncCal_(items);
  } finally { lock.releaseLock(); }
}

/* ===== ملخص الصبح ===== */
function digest() {
  var items = getJson_('rem', []), tz = tz_(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var todays = items.filter(function (it) { return Utilities.formatDate(new Date(it.due), tz, 'yyyy-MM-dd') === today; });
  var late = items.filter(function (it) { return Utilities.formatDate(new Date(it.due), tz, 'yyyy-MM-dd') < today; });
  var h = '<h3>☀️ صباح الخير يا محمد — متابعات النهارده (' + todays.length + ')</h3>';
  h += todays.length ? todays.map(itemHtml_).join('<hr>') : '<p>مفيش متابعات متسجلة النهارده.</p>';
  if (late.length) h += '<p style="color:#b91c1c"><b>🔴 متأخر: ' + late.length + '</b></p>';
  mail_('☀️ متابعات النهارده (' + todays.length + ')' + (late.length ? ' + ' + late.length + ' متأخر' : ''), h + footer_());
}

/* ===== جوجل كالندر ===== */
function syncCal_(items) {
  var cal = CalendarApp.getDefaultCalendar(), map = getJson_('ev', {}), keys = {}, now = Date.now(), made = 0;
  items.forEach(function (it) { keys[it.key] = it; });
  for (var k in map) {
    if (!keys[k]) {
      try { var ev = cal.getEventById(map[k]); if (ev) ev.deleteEvent(); } catch (e) {}
      delete map[k];
    }
  }
  items.forEach(function (it) {
    var t = new Date(it.due).getTime();
    if (map[it.key] || isNaN(t) || t < now || t > now + CAL_DAYS_AHEAD * 86400000 || made >= 25) return;
    var ev = cal.createEvent('🔔 ' + it.tag + ': ' + it.title, new Date(t), new Date(t + 30 * 60000),
      { description: (it.note || '') + (it.wa ? '\nواتساب: ' + it.wa : '') + '\nCRM: ' + (P.getProperty('crmUrl') || '') });
    ev.removeAllReminders();
    CAL_POPUPS.forEach(function (m) { ev.addPopupReminder(m); });
    map[it.key] = ev.getId();
    made++;
  });
  putJson_('ev', map);
}

/* ===== أدوات ===== */
function ensureTriggers_() {
  var names = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (names.indexOf('tick') < 0) ScriptApp.newTrigger('tick').timeBased().everyMinutes(10).create();
  if (names.indexOf('digest') < 0) ScriptApp.newTrigger('digest').timeBased().atHour(9).everyDays(1).inTimezone(tz_()).create();
}
function sendTest_() {
  mail_('✅ تنبيهات Digital Reach CRM شغالة',
    '<p>هيوصلك إيميل قبل كل متابعة بـ ' + REMIND_BEFORE_MIN + ' دقيقة، وملخص كل يوم الساعة 9 الصبح.</p>' +
    '<p>والمواعيد هتتحط لوحدها في جوجل كالندر بتنبيه قبلها بـ 15 دقيقة وساعة.</p>' + footer_());
}
function tz_() { return P.getProperty('tz') || Session.getScriptTimeZone() || 'Africa/Cairo'; }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function itemHtml_(it) {
  return '<p><b>' + esc_(it.tag) + ':</b> ' + esc_(it.title) + '<br>🕒 ' + Utilities.formatDate(new Date(it.due), tz_(), 'dd/MM hh:mm a') +
    (it.note ? '<br>📝 ' + esc_(it.note) : '') + (it.wa ? '<br><a href="' + esc_(it.wa) + '">💬 افتح واتساب</a>' : '') + '</p>';
}
function footer_() { var u = P.getProperty('crmUrl'); return u ? '<p><a href="' + esc_(u) + '">افتح الـ CRM</a></p>' : ''; }
function mail_(subject, html) {
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: subject, name: 'Digital Reach CRM',
    htmlBody: '<div dir="rtl" style="font-family:Tahoma,Arial">' + html + '</div>' });
}
function putJson_(k, obj) {
  var s = JSON.stringify(obj), n = Math.max(1, Math.ceil(s.length / 8000)), props = {};
  props[k + '_n'] = String(n);
  for (var i = 0; i < n; i++) props[k + '_' + i] = s.substr(i * 8000, 8000);
  P.setProperties(props);
}
function getJson_(k, def) {
  var n = Number(P.getProperty(k + '_n')) || 0, s = '';
  if (!n) return def;
  for (var i = 0; i < n; i++) s += P.getProperty(k + '_' + i) || '';
  try { return JSON.parse(s); } catch (e) { return def; }
}
