/**
 * Digital Reach CRM → Google Calendar (تنبيهات أوتوماتيك)
 * - كل 10 دقايق: بيقرا مواعيد المتابعة من الـ CRM ويحطها في جوجل كالندر بتنبيه قبلها بساعة وقبلها بـ 10 دقايق.
 * - كل يوم الساعة 9 الصبح: بيبعتلك إيميل بمتابعات النهارده والمتأخرة.
 * التشغيل: اختار دالة setup من فوق ودوس Run مرة واحدة بس.
 */

var API_KEY = 'AIzaSyDhZKeWe1ytVMt6Vlm4JExESk9kXq3RFeg';
var PROJECT = 'digitalreach-crm';
var DOC = 'crmData/simple';
var CRM_URL = 'https://goorymet-sketch.github.io/dr-crm-page/crm.html';
var REMINDERS = [60, 10];   // دقايق قبل الميعاد
var DAYS_AHEAD = 60;        // يزامن مواعيد لحد 60 يوم قدام

/* ===== التشغيل لأول مرة ===== */
function setup() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('EMAIL') || !p.getProperty('PASSWORD')) {
    throw new Error('ضيف EMAIL و PASSWORD في Project Settings > Script properties الأول');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(9).everyDays(1).create();
  var n = sync();
  Logger.log('تمام ✓ اتزامن ' + n + ' ميعاد. التشغيل بقى أوتوماتيك كل 10 دقايق.');
}

/* ===== قراءة الداتا من Firebase ===== */
function getToken_() {
  var p = PropertiesService.getScriptProperties();
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ email: p.getProperty('EMAIL'), password: p.getProperty('PASSWORD'), returnSecureToken: true })
  });
  var j = JSON.parse(r.getContentText());
  if (!j.idToken) throw new Error('تسجيل الدخول فشل: ' + (j.error && j.error.message));
  return j.idToken;
}
function fv_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fv_);
  if ('mapValue' in v) { var o = {}, f = v.mapValue.fields || {}; for (var k in f) o[k] = fv_(f[k]); return o; }
  return null;
}
function loadDb_() {
  var r = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/' + DOC, {
    headers: { Authorization: 'Bearer ' + getToken_() }, muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('Firestore ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return fv_({ mapValue: { fields: JSON.parse(r.getContentText()).fields || {} } });
}

/* ===== تجميع المتابعات (نفس منطق الـ CRM) ===== */
function waNumber_(p) {
  p = String(p || '').replace(/\D/g, '');
  if (p.indexOf('00') === 0) p = p.slice(2);
  if (/^01[0125]\d{8}$/.test(p)) p = '2' + p;
  else if (/^1[0125]\d{8}$/.test(p)) p = '20' + p;
  else if (/^05\d{8}$/.test(p)) p = '966' + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = '966' + p;
  return p;
}
function followUps_(db) {
  var out = [], cos = {};
  (db.companies || []).forEach(function (c) {
    cos[c.id] = c.name;
    if (c.followUp) out.push({ key: 'co_' + c.id, when: c.followUp, title: 'متابعة شركة: ' + c.name, phone: c.phone, note: c.note });
    (c.plan || []).forEach(function (p) {
      if (p.due && !p.done) out.push({ key: 'pl_' + c.id + '_' + p.id, when: p.due, title: 'خطة ' + c.name + ': ' + p.text, note: p.note });
    });
  });
  (db.sales || []).forEach(function (x) {
    if (x.followUp) out.push({ key: 'sa_' + x.id, when: x.followUp, title: 'متابعة: ' + x.name + (x.companyId && cos[x.companyId] ? ' (' + cos[x.companyId] + ')' : ''), phone: x.phone, note: x.note });
  });
  (db.broker || []).forEach(function (x) {
    if (x.followUp) out.push({ key: 'br_' + x.id, when: x.followUp, title: 'وساطة: ' + x.name + (x.contact ? ' — ' + x.contact : ''), phone: x.phone, note: x.note });
  });
  (db.tasks || []).forEach(function (x) {
    if (x.followUp && !x.done) out.push({ key: 'ta_' + x.id, when: x.followUp, title: 'مهمة: ' + x.title, phone: x.phone, note: x.note });
  });
  var tz = Session.getScriptTimeZone();
  out.forEach(function (f) {
    var s = String(f.when);
    f.start = s.length > 10 ? Utilities.parseDate(s.slice(0, 16), tz, "yyyy-MM-dd'T'HH:mm") : Utilities.parseDate(s + 'T09:00', tz, "yyyy-MM-dd'T'HH:mm");
  });
  return out;
}
function details_(f) {
  return (f.phone ? 'واتساب: https://wa.me/' + waNumber_(f.phone) + '\n' : '') + (f.note ? f.note + '\n' : '') + 'الـ CRM: ' + CRM_URL;
}

/* ===== المزامنة مع الكالندر ===== */
function sync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 0;
  try {
    var cal = CalendarApp.getDefaultCalendar();
    var props = PropertiesService.getScriptProperties();
    var saved = JSON.parse(props.getProperty('EVENTS') || '{}');   // key -> {id, t, s}
    var now = new Date(), limit = new Date(now.getTime() + DAYS_AHEAD * 86400000);
    var list = followUps_(loadDb_()).filter(function (f) { return f.start > now && f.start < limit; });
    var keep = {}, n = 0;
    list.forEach(function (f) {
      var sig = f.title + '|' + f.start.getTime() + '|' + (f.phone || '') + '|' + (f.note || '');
      var ev = saved[f.key] ? safeGet_(cal, saved[f.key].id) : null;
      var end = new Date(f.start.getTime() + 30 * 60000);
      if (ev && saved[f.key].s === sig) { keep[f.key] = saved[f.key]; n++; return; }
      if (ev) { ev.setTitle(f.title); ev.setTime(f.start, end); ev.setDescription(details_(f)); }
      else ev = cal.createEvent(f.title, f.start, end, { description: details_(f) });
      ev.removeAllReminders();
      REMINDERS.forEach(function (m) { ev.addPopupReminder(m); });
      keep[f.key] = { id: ev.getId(), s: sig };
      n++;
    });
    // امسح أحداث المتابعات اللي اتعملها "تم" أو اتحذفت أو اتغير ميعادها
    Object.keys(saved).forEach(function (k) {
      if (!keep[k]) { var ev = safeGet_(cal, saved[k].id); if (ev && ev.getStartTime() > now) ev.deleteEvent(); }
    });
    props.setProperty('EVENTS', JSON.stringify(keep));
    return n;
  } finally { lock.releaseLock(); }
}
function safeGet_(cal, id) { try { return cal.getEventById(id); } catch (e) { return null; } }

/* ===== إيميل الصبح ===== */
function dailyDigest() {
  var list = followUps_(loadDb_()), now = new Date();
  var end = new Date(now); end.setHours(23, 59, 59);
  var late = list.filter(function (f) { return f.start < now; });
  var today = list.filter(function (f) { return f.start >= now && f.start <= end; });
  if (!late.length && !today.length) return;
  var tz = Session.getScriptTimeZone();
  function line(f) { return '• ' + f.title + ' — ' + Utilities.formatDate(f.start, tz, 'dd/MM HH:mm') + (f.phone ? '  https://wa.me/' + waNumber_(f.phone) : ''); }
  var body = (late.length ? '🔴 متأخر (' + late.length + '):\n' + late.map(line).join('\n') + '\n\n' : '') +
             (today.length ? '🟡 النهارده (' + today.length + '):\n' + today.map(line).join('\n') + '\n\n' : '') + 'افتح الـ CRM: ' + CRM_URL;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '📋 متابعات النهارده: ' + (late.length + today.length), body);
}

/* ===== اختبار سريع: بيعمل حدث تجربة بعد 15 دقيقة ===== */
function testNotification() {
  var s = new Date(Date.now() + 15 * 60000);
  var ev = CalendarApp.getDefaultCalendar().createEvent('🔔 تجربة تنبيه CRM', s, new Date(s.getTime() + 15 * 60000));
  ev.removeAllReminders(); ev.addPopupReminder(10);
  Logger.log('اتعمل حدث تجربة الساعة ' + s + ' — المفروض يجيلك تنبيه بعد 5 دقايق');
}
