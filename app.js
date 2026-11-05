/*!
 * Digital Reach CRM — UI / Firebase layer
 * All business rules live in crm-core.js so they can be tested without a browser.
 */
(function () {
  'use strict';

  var C = window.CRMCore;
  var KEY = 'dr_crm_v1';
  var ALLOWED_EMAIL = 'goory.met@gmail.com';
  var NEEDS = ['زيادة المبيعات', 'ظهور على السوشيال', 'محتوى ومنشورات', 'التواصل والردود', 'عروض وحجوزات'];
  var WHATSAPP_TEXT = 'مساء الخير يا فندم لو سمحت عايز اتواصل مع مسئول المبيعات';

  var firebaseConfig = {
    apiKey: 'AIzaSyDhZKeWe1ytVMt6Vlm4JExESk9kXq3RFeg',
    authDomain: 'digitalreach-crm.firebaseapp.com',
    projectId: 'digitalreach-crm',
    storageBucket: 'digitalreach-crm.firebasestorage.app',
    messagingSenderId: '633336135091',
    appId: '1:633336135091:web:de8f20b2fa143ae6665fc6',
    measurementId: 'G-2M46FMRKYJ'
  };

  var auth = null;
  var firestore = null;
  var cloudDoc = null;
  var cloudReady = false;
  var cloudTimer = null;
  var db = loadLocal();
  var currentProfileId = null;
  var currentEditId = null;
  var selectedCompanyIds = {};
  var pendingImport = null;
  var planDirty = false;
  var planCompanyId = '';
  var settingsHydrated = false;

  /* ------------------------------------------------------------------ *
   * Tiny DOM helpers
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function opts(list, selected, blankLabel) {
    var html = blankLabel != null ? '<option value="">' + esc(blankLabel) + '</option>' : '';
    return html + list.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
  }
  function byId(arr, id) {
    for (var i = 0; i < (arr || []).length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function today() { return C.todayISO(); }
  function addDays(dateStr, days) {
    var d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shortDate(v) {
    var s = C.text(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }
  function safeUrl(value) {
    var url = String(value || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return /^https?:\/\//i.test(url) ? url : '';
  }
  function linkBtn(url, label) {
    var href = safeUrl(url);
    return href ? '<a class="btn s" target="_blank" rel="noopener noreferrer" href="' + esc(href) + '">' + esc(label) + '</a>' : '';
  }
  function whatsappUrl(company) {
    var phone = String((company && (company.whatsapp || company.phone)) || '').replace(/[^0-9]/g, '');
    if (phone.indexOf('00') === 0) phone = phone.slice(2);
    if (!phone) return '';
    return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(WHATSAPP_TEXT);
  }
  function badge(text, color) {
    return '<span class="badge" style="--bc:' + esc(color) + '">' + esc(text) + '</span>';
  }
  function clsBadge(cls) {
    if (!cls) return '<span class="badge" style="--bc:#aab3d1">غير مصنّف</span>';
    return '<span class="badge" style="--bc:' + C.classificationColor(cls) + '">' + esc(cls) + '</span>';
  }
  function fitBadge(fit) {
    return '<span class="badge" style="--bc:' + C.classificationColor(fit.classification) + '">' + esc(fit.score) + ' · ' + esc(fit.classification || '—') + '</span>';
  }
  function card(label, value) {
    return '<div class="stat"><small>' + esc(label) + '</small><div>' + value + '</div></div>';
  }
  function valueLines(list) {
    if (!list || !list.length) return '<span class="muted">—</span>';
    return list.map(function (x) { return '<div class="money">' + esc(x.label) + '</div>'; }).join('');
  }
  function toast(message, type) {
    var host = $('toasts');
    if (!host) { return; }
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 5000);
  }
  function setAuthMessage(message) { var el = $('authMsg'); if (el) el.textContent = message || ''; }
  function setCloudStatus(message, cls) {
    var el = $('cloudStatus');
    if (el) { el.textContent = message || ''; el.className = 'cloud-status ' + (cls || ''); }
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  function loadLocal() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return C.normalizeDb({});
      var parsed = JSON.parse(raw);
      return C.normalizeDb(parsed);
    } catch (e) {
      console.error('Local load failed', e);
      return C.normalizeDb({});
    }
  }

  function cloudPayload() {
    var payload = {
      companies: db.companies,
      posts: db.posts,
      plans: db.plans,
      campaigns: db.campaigns,
      settings: db.settings,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    Object.keys(db).forEach(function (k) {
      if (!(k in payload)) payload[k] = db[k];
    });
    return payload;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      toast('تعذّر الحفظ المحلي. نزّل نسخة احتياطية فورًا.', 'err');
    }
    if (!cloudReady || !cloudDoc) return;
    setCloudStatus('جاري الحفظ السحابي…', 'busy');
    if (cloudTimer) clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () {
      cloudDoc.set(cloudPayload()).then(function () {
        setCloudStatus('محفوظ سحابيًا · ' + new Date().toLocaleTimeString('ar-EG'), 'ok');
      }).catch(function (e) {
        console.error('Cloud save failed', e);
        setCloudStatus('فشل الحفظ السحابي — البيانات محفوظة محليًا.', 'err');
        toast('الحفظ السحابي فشل. راجع الاتصال وقواعد Firestore، ونزّل نسخة احتياطية.', 'err');
      });
    }, 500);
  }

  function companyOf(id) { return byId(db.companies, id); }
  function planOf(id) {
    var p = db.plans[id];
    return p ? C.normalizePlan(p) : null;
  }

  /* ------------------------------------------------------------------ *
   * Company editor
   * ------------------------------------------------------------------ */

  var COMPANY_SECTIONS = [
    {
      title: 'البيانات الأساسية',
      fields: [
        { k: 'name', l: 'اسم الشركة *', req: true, full: true },
        { k: 'industry', l: 'النشاط' },
        { k: 'sector', l: 'القطاع', t: 'select', o: C.SECTORS, blank: 'غير محدد' },
        { k: 'country', l: 'الدولة', t: 'select', o: C.COUNTRIES, blank: 'غير محدد' },
        { k: 'targetMarket', l: 'السوق المستهدف' },
        { k: 'website', l: 'الموقع الإلكتروني', full: true },
        { k: 'phone', l: 'رقم الهاتف' },
        { k: 'whatsapp', l: 'رقم واتساب' },
        { k: 'contact', l: 'اسم المسؤول' },
        { k: 'contactRole', l: 'منصب المسؤول' },
        { k: 'employees', l: 'عدد الموظفين (رقم أو نطاق)' },
        { k: 'annualRevenueEstimate', l: 'المبيعات السنوية التقديرية (بالعملة والنطاق)' },
        { k: 'currency', l: 'العملة', t: 'select', o: C.CURRENCIES, blank: 'غير محدد' },
        { k: 'revenueConfidence', l: 'مستوى الثقة في تقدير المبيعات', t: 'select', o: C.CONFIDENCE_LEVELS },
        { k: 'estimateBasis', l: 'مصدر التقدير وأساسه', t: 'textarea', full: true, r: 2 },
        { k: 'facebook', l: 'رابط Facebook', full: true },
        { k: 'instagram', l: 'رابط Instagram', full: true },
        { k: 'linkedin', l: 'رابط LinkedIn', full: true }
      ]
    },
    {
      title: 'تحليل الشركة',
      fields: [
        { k: 'opportunityType', l: 'نوع الفرصة', t: 'select', o: C.OPPORTUNITY_TYPES },
        { k: 'priority', l: 'الأولوية', t: 'select', o: C.PRIORITIES },
        { k: 'observedOpportunity', l: 'الفرصة البيعية الملحوظة', t: 'textarea', full: true, r: 2 },
        { k: 'problem', l: 'المشكلة المحتملة التي يمكن أن نعالجها', t: 'textarea', full: true, r: 2 },
        { k: 'salesAngle', l: 'زاوية البيع المناسبة', t: 'textarea', full: true, r: 2 },
        { k: 'researchSummary', l: 'ملخص البحث', t: 'textarea', full: true, r: 3 },
        { k: 'researchSources', l: 'مصادر البحث وروابطها (سطر لكل مصدر: العنوان | الرابط)', t: 'textarea', full: true, r: 3 },
        { k: 'researchUpdatedAt', l: 'آخر تاريخ تحديث التحليل', t: 'date' },
        { k: 'classificationOverride', l: 'تصنيف يدوي (اختياري)', t: 'select', o: C.CLASSIFICATIONS, blank: 'حسب الدرجة' },
        { k: 'fitConfidence', l: 'مستوى الثقة في التحليل', t: 'select', o: C.CONFIDENCE_LEVELS }
      ]
    },
    {
      title: 'مكونات تقييم الملاءمة (0–100، واتركه فارغًا للحساب التلقائي)',
      fit: true,
      fields: [
        { k: 'fitService', l: 'ملاءمة الخدمة (وزن 30)', t: 'number', min: 0, max: 100 },
        { k: 'fitCommercial', l: 'الإمكانية التجارية (وزن 20)', t: 'number', min: 0, max: 100 },
        { k: 'fitOpportunity', l: 'الفرصة/المشكلة (وزن 20)', t: 'number', min: 0, max: 100 },
        { k: 'fitMarket', l: 'ملاءمة السوق (وزن 15)', t: 'number', min: 0, max: 100 },
        { k: 'fitAccess', l: 'سهولة الوصول (وزن 15)', t: 'number', min: 0, max: 100 }
      ]
    },
    {
      title: 'المبيعات والمتابعة',
      fields: [
        { k: 'stage', l: 'المرحلة', t: 'select', o: C.STAGE_KEYS },
        { k: 'replyStatus', l: 'حالة الرد', t: 'select', o: C.REPLY_STATUSES },
        { k: 'value', l: 'قيمة الصفقة', t: 'number' },
        { k: 'probability', l: 'احتمالية الإغلاق %', t: 'number', min: 0, max: 100 },
        { k: 'source', l: 'المصدر', t: 'select', o: C.SOURCES },
        { k: 'campaign', l: 'الحملة / قائمة العملاء', list: 'campaignList' },
        { k: 'owner', l: 'الشخص المسؤول عن المتابعة' },
        { k: 'followUpDate', l: 'موعد المتابعة القادمة', t: 'date' },
        { k: 'meetingDate', l: 'موعد الاجتماع', t: 'date' },
        { k: 'lastContactAt', l: 'تاريخ آخر تواصل', t: 'date' },
        { k: 'lostReason', l: 'سبب خسارة الفرصة', t: 'textarea', full: true, r: 2 },
        { k: 'notes', l: 'ملاحظات', t: 'textarea', full: true, r: 3 }
      ]
    }
  ];

  function formValues(c) {
    var v = {};
    COMPANY_SECTIONS.forEach(function (sec) {
      sec.fields.forEach(function (f) {
        if (f.k.indexOf('fit') === 0) {
          var key = f.k.replace('fit', '').toLowerCase();
          var val = c && c.fitBreakdown ? c.fitBreakdown[key] : null;
          v[f.k] = val == null ? '' : val;
        } else if (f.k === 'researchSources') {
          v[f.k] = (c && c.researchSources ? c.researchSources : []).map(function (s) {
            return s.label + (s.url ? ' | ' + s.url : '');
          }).join('\n');
        } else {
          v[f.k] = c && c[f.k] != null ? c[f.k] : '';
        }
      });
    });
    return v;
  }

  function fieldHtml(f, v) {
    var cls = 'field' + (f.full ? ' full' : '');
    var label = '<label>' + esc(f.l);
    var input;
    var dv = v[f.k] == null ? '' : v[f.k];
    if (f.t === 'select') {
      input = '<select name="' + f.k + '">' + opts(f.o, dv, f.blank) + '</select>';
    } else if (f.t === 'textarea') {
      input = '<textarea name="' + f.k + '" rows="' + (f.r || 3) + '">' + esc(dv) + '</textarea>';
    } else {
      input = '<input name="' + f.k + '" type="' + (f.t || 'text') + '" value="' + esc(dv) + '"' +
        (f.list ? ' list="' + f.list + '"' : '') +
        (f.t === 'number' ? ' step="any"' : '') +
        (f.min != null ? ' min="' + f.min + '"' : '') +
        (f.max != null ? ' max="' + f.max + '"' : '') +
        (f.req ? ' required' : '') + '>';
    }
    return '<div class="' + cls + '">' + label + input + '</label></div>';
  }

  function openCompanyForm(id) {
    currentEditId = id || null;
    var c = id ? companyOf(id) : C.normalizeCompany({});
    var v = formValues(c);
    if (!id) {
      v.stage = 'جديد';
      v.replyStatus = 'لم يتم التواصل';
      v.source = 'أخرى';
      v.priority = 'متوسطة';
      v.opportunityType = 'عميل محتمل';
      v.probability = C.stageProbability('جديد');
    }
    $('companyTitle').textContent = id ? 'تعديل شركة' : 'إضافة شركة';
    $('companyFields').innerHTML = COMPANY_SECTIONS.map(function (sec) {
      return '<div class="form-section"><h3>' + esc(sec.title) + '</h3><div class="form-grid">' +
        sec.fields.map(function (f) { return fieldHtml(f, v); }).join('') + '</div></div>';
    }).join('');
    $('companyDlg').showModal();
    updateFitPreview();
  }

  function readFormValue(name) {
    var el = $('companyForm').elements.namedItem(name);
    return el ? String(el.value == null ? '' : el.value).trim() : '';
  }

  function collectCompanyData() {
    var data = {};
    COMPANY_SECTIONS.forEach(function (sec) {
      sec.fields.forEach(function (f) {
        var val = readFormValue(f.k);
        if (f.k.indexOf('fit') === 0) {
          var key = f.k.replace('fit', '').toLowerCase();
          if (!data.fitBreakdown) data.fitBreakdown = { service: null, commercial: null, opportunity: null, market: null, access: null };
          data.fitBreakdown[key] = val === '' ? null : C.clamp(num(val), 0, 100);
        } else if (f.k === 'researchSources') {
          data.researchSources = val.split(/\r?\n/).map(function (line) {
            var parts = line.split('|');
            return { label: (parts[0] || '').trim(), url: (parts[1] || '').trim() };
          }).filter(function (s) { return s.label || s.url; });
          data.researchSource = data.researchSources.map(function (s) { return s.label; }).filter(Boolean).join(' | ');
        } else if (f.k === 'value' || f.k === 'probability') {
          data[f.k] = val === '' ? '' : num(val);
        } else {
          data[f.k] = val;
        }
      });
    });
    return data;
  }

  function previewCompany() {
    var data = collectCompanyData();
    var c = C.normalizeCompany(data);
    c.fitMode = 'components';
    return C.computeFit(c, db.settings.fitWeights);
  }

  function updateFitPreview() {
    var host = $('fitPreview');
    if (!host) return;
    var fit = previewCompany();
    host.innerHTML = '<div class="fit-preview">' +
      '<div><small>النتيجة الحالية</small><div class="fit-score" style="color:' + C.classificationColor(fit.classification) + '">' +
      esc(fit.score) + ' / 100</div>' + clsBadge(fit.classification) + '</div>' +
      '<div><small>الثقة</small><div>' + esc(fit.confidence) + '</div></div>' +
      '<div><small>الحالة</small><div>' + (fit.preliminary ? 'تقييم أولي — يحتاج بحثًا' : 'مكتمل نسبيًا') + '</div></div>' +
      '<div class="fit-notes">' + (fit.notes || []).map(function (n) { return '<div>• ' + esc(n) + '</div>'; }).join('') + '</div>' +
      '</div>';
  }

  function saveCompany(e) {
    e.preventDefault();
    var data = collectCompanyData();
    if (!data.name) { alert('اسم الشركة مطلوب.'); return; }
    var c = currentEditId ? companyOf(currentEditId) : null;
    var oldStage = c ? c.stage : '';
    var newStage = data.stage || 'جديد';
    delete data.stage;
    if (c) {
      Object.keys(data).forEach(function (k) { c[k] = data[k]; });
      if (oldStage !== newStage) C.recordStageChange(c, newStage);
      else c.stage = newStage;
      c.fitMode = 'components';
      c.probabilityManual = Number(c.probability) !== C.stageProbability(c.stage);
    } else {
      c = C.normalizeCompany(data);
      c.id = C.uid();
      c.created = today();
      c.createdAt = new Date().toISOString();
      c.stage = newStage;
      c.stageHistory = [];
      c.contacts = [];
      c.activities = [];
      c.fitMode = 'components';
      c.probability = c.probability === '' ? C.stageProbability(newStage) : num(c.probability);
      c.probabilityManual = Number(c.probability) !== C.stageProbability(newStage);
      C.appendActivity(c, 'إنشاء الشركة', 'تمت إضافة الشركة إلى CRM.');
      db.companies.push(c);
    }
    var fit = C.computeFit(c, db.settings.fitWeights);
    c.fitScore = fit.score;
    if (data.fitConfidence === 'غير محدد') c.fitConfidence = 'غير محدد';
    save();
    renderAll();
    $('companyDlg').close();
    toast(c.name + ' — تم الحفظ (Fit ' + fit.score + '، ' + (fit.classification || 'غير مصنّف') + ')', 'ok');
  }

  function deleteCompany(id) {
    var c = companyOf(id);
    if (!c) return;
    if (!confirm('تمسح "' + c.name + '" وخطتها؟ مفيش رجوع. نزّل نسخة احتياطية قبل المتابعة.')) return;
    db.companies = db.companies.filter(function (x) { return x.id !== id; });
    delete db.plans[id];
    delete selectedCompanyIds[id];
    save(); renderAll();
    toast('تم حذف الشركة.', 'ok');
  }


  /* ------------------------------------------------------------------ *
   * Sales table
   * ------------------------------------------------------------------ */

  function fitFor(c) { return C.computeFit(c, db.settings.fitWeights); }

  function companySearchBlob(c) {
    return [
      c.name, c.contact, c.contactRole, c.phone, c.whatsapp, c.industry, c.sector, c.country, c.targetMarket,
      c.source, c.campaign, c.notes, c.website, c.facebook, c.instagram, c.linkedin, c.employees,
      c.annualRevenueEstimate, c.estimateBasis, c.replyStatus, c.lostReason, c.owner, c.observedOpportunity,
      c.problem, c.salesAngle, c.researchSummary, c.stage
    ].join(' ').toLowerCase();
  }

  function filteredCompanies() {
    var q = C.text($('q').value).trim().toLowerCase();
    var stage = $('fst').value;
    var cls = $('fcls').value;
    var sector = $('fsector').value;
    var country = $('fcountry').value;
    var campaign = $('fcampaign').value;
    var sort = $('fsort').value;
    var list = db.companies.filter(function (c) {
      if (stage && c.stage !== stage) return false;
      if (sector && (c.sector || 'غير محدد') !== sector) return false;
      if (country && (c.country || 'غير محدد') !== country) return false;
      if (campaign && (c.campaign || '') !== campaign) return false;
      if (cls && fitFor(c).classification !== cls) return false;
      return !q || companySearchBlob(c).indexOf(q) > -1;
    });
    if (sort === 'fit') list.sort(function (a, b) { return fitFor(b).score - fitFor(a).score; });
    else if (sort === 'priority') {
      var rank = { 'عالية': 0, 'متوسطة': 1, 'منخفضة': 2 };
      list.sort(function (a, b) { return (rank[a.priority] == null ? 3 : rank[a.priority]) - (rank[b.priority] == null ? 3 : rank[b.priority]); });
    } else if (sort === 'followup') {
      list.sort(function (a, b) {
        var x = a.followUpDate || '9999-99-99';
        var y = b.followUpDate || '9999-99-99';
        return String(x).localeCompare(String(y));
      });
    } else if (sort === 'name') {
      list.sort(function (a, b) { return C.text(a.name).localeCompare(C.text(b.name)); });
    } else if (sort === 'value') {
      list.sort(function (a, b) { return num(b.value) - num(a.value); });
    } else {
      list.sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
    }
    return list;
  }

  function miniFit(fit) {
    var color = C.classificationColor(fit.classification);
    return '<div class="fit-cell"><div class="fit-bar"><i style="width:' + C.clamp(fit.score, 0, 100) + '%;background:' + color + '"></i></div>' +
      '<b>' + esc(fit.score) + '</b>' + (fit.preliminary ? '<span class="warn-dot" title="تقييم أولي">!</span>' : '') + '</div>';
  }

  function renderSales() {
    var m = C.dashboardMetrics(db.companies, { weights: db.settings.fitWeights });
    $('stats').innerHTML = [
      card('إجمالي الشركات', esc(m.total)),
      card('HOT', '<span style="color:#ff6b6b">' + esc(m.classified.HOT || 0) + '</span>'),
      card('WARM', '<span style="color:#ffc400">' + esc(m.classified.WARM || 0) + '</span>'),
      card('COLD', '<span style="color:#58bec6">' + esc(m.classified.COLD || 0) + '</span>'),
      card('صفقات مفتوحة', esc(m.openDeals)),
      card('مغلقة (Won)', esc(m.wonDeals)),
      card('قيمة المفتوح', valueLines(m.openValueList))
    ].join('');

    var list = filteredCompanies();
    $('tbC').innerHTML = list.length ? list.map(function (c, i) {
      var fit = fitFor(c);
      var wa = whatsappUrl(c);
      var overdue = c.followUpDate && c.followUpDate < today() && C.isOpenStage(c.stage);
      return '<tr>' +
        '<td><input type="checkbox" data-company-select="' + esc(c.id) + '"' + (selectedCompanyIds[c.id] ? ' checked' : '') + '></td>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><b>' + esc(c.name) + '</b><div class="row-sub">' + esc(c.sector || 'غير محدد') + (c.campaign ? ' · ' + esc(c.campaign) : '') + '</div></td>' +
        '<td>' + esc(c.contact || '—') + '<div class="row-sub" dir="ltr">' + esc(c.phone || '') + '</div></td>' +
        '<td>' + esc(c.country || '—') + '</td>' +
        '<td>' + clsBadge(fit.classification) + '<div class="row-sub">ثقة: ' + esc(fit.confidence) + '</div></td>' +
        '<td>' + miniFit(fit) + '</td>' +
        '<td><select data-stg="' + esc(c.id) + '">' + opts(C.STAGE_KEYS, c.stage) + '</select></td>' +
        '<td><span class="status-pill">' + esc(c.replyStatus || 'لم يتم التواصل') + '</span></td>' +
        '<td>' + (c.value !== '' && c.value != null ? esc(C.formatMoney(c.value, c.currency)) : '—') + '</td>' +
        '<td class="' + (overdue ? 'overdue' : '') + '">' + (c.followUpDate ? esc(c.followUpDate) : '—') + '</td>' +
        '<td><div class="act">' +
        (wa ? '<a class="btn t s" target="_blank" rel="noopener" href="' + esc(wa) + '">واتساب</a>' : '<button class="btn s" disabled>واتساب</button>') +
        '<button class="btn s" data-act="profileC" data-id="' + esc(c.id) + '">الملف</button>' +
        '<button class="btn s" data-act="eC" data-id="' + esc(c.id) + '">تعديل</button>' +
        '<button class="btn s" data-act="planC" data-id="' + esc(c.id) + '">الخطة</button>' +
        '<button class="btn d" data-act="dC" data-id="' + esc(c.id) + '">حذف</button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td colspan="12" class="empty">' + (db.companies.length ? 'مفيش نتائج مطابقة للفلاتر.' : 'لسه مفيش شركات. دوس "إضافة شركة" أو استورد CSV.') + '</td></tr>';
    renderBulkState(list);
  }

  function renderBulkState(visible) {
    var ids = Object.keys(selectedCompanyIds).filter(function (id) { return selectedCompanyIds[id]; });
    $('selectedCount').textContent = ids.length + ' شركة محددة';
    $('bulkEdit').disabled = !ids.length;
    $('bulkDelete').disabled = !ids.length;
    $('clearSelection').disabled = !ids.length;
    var all = visible && visible.length > 0 && visible.every(function (c) { return !!selectedCompanyIds[c.id]; });
    var box = $('selectAllCompanies');
    box.checked = !!all;
    box.indeterminate = !!(visible && visible.some(function (c) { return !!selectedCompanyIds[c.id]; }) && !all);
  }

  function selectedIds() {
    return Object.keys(selectedCompanyIds).filter(function (id) { return selectedCompanyIds[id]; });
  }

  var BULK_FIELDS = [
    { k: 'stage', l: 'المرحلة', t: 'select', o: C.STAGE_KEYS },
    { k: 'replyStatus', l: 'حالة الرد', t: 'select', o: C.REPLY_STATUSES },
    { k: 'priority', l: 'الأولوية', t: 'select', o: C.PRIORITIES },
    { k: 'owner', l: 'المسؤول عن المتابعة', t: 'text' },
    { k: 'campaign', l: 'الحملة', t: 'text' },
    { k: 'source', l: 'المصدر', t: 'select', o: C.SOURCES },
    { k: 'followUpDate', l: 'موعد المتابعة', t: 'date' },
    { k: 'lostReason', l: 'سبب الخسارة', t: 'text' },
    { k: 'classificationOverride', l: 'التصنيف اليدوي', t: 'select', o: C.CLASSIFICATIONS, blank: 'حسب الدرجة' }
  ];

  function renderBulkValue() {
    var key = $('bulkField').value;
    var f = BULK_FIELDS.filter(function (x) { return x.k === key; })[0];
    if (!f) return;
    if (f.t === 'select') $('bulkValueHost').innerHTML = '<select id="bulkValue">' + opts(f.o, '', f.blank) + '</select>';
    else $('bulkValueHost').innerHTML = '<input id="bulkValue" type="' + f.t + '">';
  }

  function openBulkEdit() {
    if (!selectedIds().length) return;
    $('bulkField').innerHTML = BULK_FIELDS.map(function (f) { return '<option value="' + esc(f.k) + '">' + esc(f.l) + '</option>'; }).join('');
    renderBulkValue();
    $('bulkCount').textContent = selectedIds().length + ' شركة';
    $('bulkDlg').showModal();
  }

  function applyBulkEdit() {
    var ids = selectedIds();
    var field = $('bulkField').value;
    var value = $('bulkValue').value;
    if (!confirm('هيتم تعديل ' + ids.length + ' شركة. متأكد؟')) return;
    ids.forEach(function (id) {
      var c = companyOf(id);
      if (!c) return;
      if (field === 'stage') {
        if (c.stage !== value) C.recordStageChange(c, value);
      } else if (field === 'classificationOverride') {
        c.classificationOverride = value;
        C.appendActivity(c, 'تعديل جماعي', 'التصنيف اليدوي: ' + (value || 'حسب الدرجة'));
      } else {
        c[field] = value;
        C.appendActivity(c, 'تعديل جماعي', 'تم تحديث الحقل: ' + field + ' إلى ' + (value || 'فارغ'));
      }
    });
    save(); renderAll(); $('bulkDlg').close();
    toast('تم التعديل الجماعي لـ ' + ids.length + ' شركة.', 'ok');
  }
  /* ------------------------------------------------------------------ *
   * Company profile
   * ------------------------------------------------------------------ */

  function socialLinks(c) {
    var links = [linkBtn(c.website, 'الموقع'), linkBtn(c.facebook, 'Facebook'), linkBtn(c.instagram, 'Instagram'), linkBtn(c.linkedin, 'LinkedIn')].filter(Boolean);
    return links.length ? links.join(' ') : '<span class="muted">—</span>';
  }

  function renderProfile() {
    var c = companyOf(currentProfileId);
    if (!c) return;
    var fit = fitFor(c);
    $('profileName').textContent = c.name || '';
    $('profileBadges').innerHTML = clsBadge(fit.classification) + ' ' +
      badge(c.opportunityType || 'عميل محتمل', '#58bec6') + ' ' +
      badge(c.stage, '#aab3d1') + ' ' +
      badge('أولوية ' + (c.priority || 'متوسطة'), '#ffc400') + ' ' +
      (fit.preliminary ? badge('تقييم أولي', '#ff6b6b') : '');

    $('profileSummary').innerHTML = [
      ['القطاع', c.sector || 'غير محدد'], ['النشاط', c.industry || '—'],
      ['الدولة', c.country || '—'], ['السوق المستهدف', c.targetMarket || '—'],
      ['المسؤول', c.contact || '—'], ['المنصب', c.contactRole || '—'],
      ['الهاتف', c.phone || '—'], ['واتساب', c.whatsapp || '—'],
      ['عدد الموظفين', c.employees || '—'], ['المبيعات التقديرية', c.annualRevenueEstimate || '—'],
      ['ثقة التقدير', c.revenueConfidence || 'غير محدد'], ['أساس التقدير', c.estimateBasis || '—'],
      ['المصدر', c.source || '—'], ['الحملة', c.campaign || '—'],
      ['المسؤول عن المتابعة', c.owner || '—'], ['روابط الشركة', socialLinks(c)]
    ].map(function (x) {
      return '<div><small>' + esc(x[0]) + '</small>' + (x[0] === 'روابط الشركة' ? x[1] : esc(x[1])) + '</div>';
    }).join('');

    var components = fit.components && fit.components.length ? '<div class="tw"><table class="compact"><thead><tr><th>المعيار</th><th>الوزن</th><th>القيمة</th><th>المصدر</th></tr></thead><tbody>' +
      fit.components.map(function (x) {
        return '<tr><td>' + esc(x.label) + '</td><td>' + esc(x.weight) + '</td><td>' + esc(x.value) +
          '</td><td>' + (x.source === 'manual' ? 'يدوي' : x.source === 'auto' ? 'تقدير تلقائي' : 'ناقص') +
          '<div class="row-sub">' + esc(x.note || '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="note">هذه درجة قديمة محفوظة من النسخة السابقة. افتح "تعديل" وأعد التقييم بالمعايير الخمسة.</div>';

    $('profileFit').innerHTML =
      '<div class="fit-head"><div class="fit-score" style="color:' + C.classificationColor(fit.classification) + '">' + esc(fit.score) + ' / 100</div>' +
      '<div>' + clsBadge(fit.classification) + '<div>الثقة: <b>' + esc(fit.confidence) + '</b></div>' +
      '<div class="row-sub">' + (fit.preliminary ? 'تقييم أولي ويحتاج بحثًا إضافيًا' : 'مبني على معايير مقيّمة') + '</div></div></div>' +
      components +
      (fit.notes && fit.notes.length ? '<div class="note warn">' + fit.notes.map(function (n) { return '• ' + esc(n); }).join('<br>') + '</div>' : '');

    $('profileResearch').innerHTML =
      '<div class="profile-summary">' +
      '<div><small>نوع الفرصة</small>' + esc(c.opportunityType || '—') + '</div>' +
      '<div><small>آخر تحديث للتحليل</small>' + esc(c.researchUpdatedAt || '—') + '</div>' +
      '<div><small>الفرصة الملحوظة</small>' + esc(c.observedOpportunity || 'غير مسجلة') + '</div>' +
      '<div><small>المشكلة المحتملة</small>' + esc(c.problem || 'غير مسجلة') + '</div>' +
      '<div><small>زاوية البيع</small>' + esc(c.salesAngle || 'غير مسجلة') + '</div>' +
      '<div><small>ملخص البحث</small>' + esc(c.researchSummary || 'غير مسجل') + '</div>' +
      '</div>' +
      '<div class="note"><b>مصادر البحث:</b> ' + ((c.researchSources || []).length ? c.researchSources.map(function (s) {
        return s.url ? '<a class="src-link" target="_blank" rel="noopener" href="' + esc(safeUrl(s.url)) + '">' + esc(s.label || s.url) + '</a>' : esc(s.label);
      }).join(' · ') : 'غير مسجلة') + '</div>';

    $('profileSales').innerHTML =
      '<div class="profile-summary">' +
      '<div><small>المرحلة</small>' + esc(c.stage) + '</div>' +
      '<div><small>حالة الرد</small>' + esc(c.replyStatus || '—') + '</div>' +
      '<div><small>قيمة الصفقة</small>' + (c.value !== '' && c.value != null ? esc(C.formatMoney(c.value, c.currency)) : '—') + '</div>' +
      '<div><small>احتمالية الإغلاق</small>' + esc(C.dealProbability(c)) + '%</div>' +
      '<div><small>القيمة المرجّحة</small>' + (c.value !== '' && c.value != null ? esc(C.formatMoney(num(c.value) * C.dealProbability(c) / 100, c.currency)) : '—') + '</div>' +
      '<div><small>آخر تواصل</small>' + esc(c.lastContactAt ? String(c.lastContactAt).slice(0, 10) : '—') + '</div>' +
      '<div><small>المتابعة القادمة</small>' + esc(c.followUpDate || '—') + '</div>' +
      '<div><small>موعد الاجتماع</small>' + esc(c.meetingDate || '—') + '</div>' +
      '<div><small>سبب الخسارة</small>' + esc(c.lostReason || '—') + '</div>' +
      '<div><small>ملاحظات</small>' + esc(c.notes || '—') + '</div>' +
      '</div>';

    $('profileReplyStatus').value = c.replyStatus || 'لم يتم التواصل';
    $('profileFollowUp').value = c.followUpDate || '';
    $('profileMeetingDate').value = c.meetingDate || '';
    $('profileLostReason').value = c.lostReason || '';

    $('profileContacts').innerHTML = c.contacts.length ? c.contacts.map(function (p) {
      var wa = p.phone ? whatsappUrl({ phone: p.phone }) : '';
      return '<div class="contact-row"><span><b>' + esc(p.name || 'بدون اسم') + '</b> ' + esc(p.role || '') +
        '<br><span dir="ltr">' + esc(p.phone || '') + '</span> ' + esc(p.email || '') + '</span><span class="act">' +
        (wa ? '<a class="btn t s" target="_blank" rel="noopener" href="' + esc(wa) + '">واتساب</a>' : '') +
        '<button class="btn d s" data-contact-delete="' + esc(p.id) + '">حذف</button></span></div>';
    }).join('') : '<div class="note">لسه مفيش جهات اتصال إضافية مسجلة.</div>';

    var acts = (c.activities || []).slice().reverse();
    $('activityTimeline').innerHTML = acts.length ? acts.map(function (a) {
      return '<div class="timeline-item"><small>' + esc(a.date || (a.at ? String(a.at).slice(0, 16).replace('T', ' ') : '')) + ' — ' + esc(a.type || 'نشاط') + '</small><p>' + esc(a.note || '') + '</p></div>';
    }).join('') : '<div class="note">سجل التواصل لسه فاضي.</div>';
  }

  function openProfile(id) {
    if (!companyOf(id)) return;
    currentProfileId = id;
    ['newContactName', 'newContactRole', 'newContactPhone', 'newContactEmail', 'activityNote'].forEach(function (k) { if ($(k)) $(k).value = ''; });
    renderProfile();
    $('profileDlg').showModal();
  }

  function addContact() {
    var c = companyOf(currentProfileId);
    if (!c) return;
    var p = {
      id: C.uid(),
      name: $('newContactName').value.trim(),
      role: $('newContactRole').value.trim(),
      phone: $('newContactPhone').value.trim(),
      email: $('newContactEmail').value.trim()
    };
    if (!p.name && !p.phone && !p.email) { alert('اكتب اسم أو رقم أو بريد جهة الاتصال.'); return; }
    if (!Array.isArray(c.contacts)) c.contacts = [];
    c.contacts.push(p);
    C.appendActivity(c, 'إضافة جهة اتصال', 'تمت إضافة جهة اتصال: ' + (p.name || p.phone || p.email));
    ['newContactName', 'newContactRole', 'newContactPhone', 'newContactEmail'].forEach(function (k) { $(k).value = ''; });
    save(); renderProfile(); renderAll();
    toast('تمت إضافة جهة الاتصال.', 'ok');
  }

  function addActivity() {
    var c = companyOf(currentProfileId);
    if (!c) return;
    var note = $('activityNote').value.trim();
    if (!note) { alert('اكتب تفاصيل النشاط الأول.'); return; }
    C.appendActivity(c, $('activityType').value, note);
    c.replyStatus = $('profileReplyStatus').value;
    $('activityNote').value = '';
    save(); renderProfile(); renderAll();
    toast('تم تسجيل النشاط.', 'ok');
  }

  function saveProfileMeta() {
    var c = companyOf(currentProfileId);
    if (!c) return;
    c.followUpDate = $('profileFollowUp').value;
    c.meetingDate = $('profileMeetingDate').value;
    c.lostReason = $('profileLostReason').value.trim();
    c.replyStatus = $('profileReplyStatus').value;
    C.appendActivity(c, 'تحديث بيانات المتابعة', 'حالة الرد: ' + c.replyStatus +
      ' | موعد المتابعة: ' + (c.followUpDate || 'غير محدد') +
      ' | الاجتماع: ' + (c.meetingDate || 'غير محدد') +
      (c.lostReason ? ' | سبب الخسارة: ' + c.lostReason : ''));
    save(); renderProfile(); renderAll();
    alert('تم حفظ بيانات المتابعة.');
  }

  /* ------------------------------------------------------------------ *
   * Follow-up center
   * ------------------------------------------------------------------ */

  function fuSection(title, hint, list, dateKey, tone) {
    var rows = list.length ? list.map(function (c) {
      var wa = whatsappUrl(c);
      return '<tr>' +
        '<td><b>' + esc(c.name) + '</b><div class="row-sub">' + esc(c.sector || '—') + ' · ' + esc(c.campaign || 'بدون حملة') + '</div></td>' +
        '<td>' + esc(c.stage) + '</td>' +
        '<td><span class="status-pill">' + esc(c.replyStatus || '—') + '</span></td>' +
        '<td>' + esc(c[dateKey] || '—') + '</td>' +
        '<td>' + (c.value !== '' && c.value != null ? esc(C.formatMoney(c.value, c.currency)) : '—') + '</td>' +
        '<td><div class="act">' + (wa ? '<a class="btn t s" target="_blank" rel="noopener" href="' + esc(wa) + '">واتساب</a>' : '') +
        '<button class="btn s" data-act="profileC" data-id="' + esc(c.id) + '">فتح الملف</button>' +
        '<button class="btn s" data-act="planC" data-id="' + esc(c.id) + '">الخطة</button></div></td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">مفيش عناصر في القائمة دي.</td></tr>';
    return '<div class="card fu-card ' + (tone || '') + '"><div class="fu-title"><b>' + esc(title) + '</b><span class="badge" style="--bc:var(--t)">' + list.length + '</span></div>' +
      '<div class="note">' + esc(hint) + '</div>' +
      '<div class="tw"><table><thead><tr><th>الشركة</th><th>المرحلة</th><th>حالة الرد</th><th>التاريخ</th><th>القيمة</th><th>إجراء</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function renderFollowups() {
    var b = C.followupBuckets(db.companies, today());
    $('followStats').innerHTML = [
      card('متابعات متأخرة', '<span style="color:#ff6b6b">' + b.overdue.length + '</span>'),
      card('مستحقة اليوم', '<span style="color:#ffc400">' + b.dueToday.length + '</span>'),
      card('قادمة', b.upcoming.length),
      card('لم يتم التواصل', b.neverContacted.length),
      card('ردوا ولم يُتابعوا', b.repliedNotFollowed.length),
      card('محوّلون للإدارة', b.forwarded.length),
      card('اجتماعات قادمة', b.meetings.length)
    ].join('');
    $('fuSections').innerHTML =
      fuSection('متابعات متأخرة', 'موعد المتابعة فات وما زالت الفرصة مفتوحة — ابدأ من هنا.', b.overdue, 'followUpDate', 'tone-red') +
      fuSection('مستحقة اليوم', 'متابعات مستحقة اليوم.', b.dueToday, 'followUpDate', 'tone-yellow') +
      fuSection('متابعات قادمة', 'مواعيد مستقبلية مرتبة تصاعديًا.', b.upcoming, 'followUpDate', '') +
      fuSection('لم يتم التواصل معهم', 'شركات جديدة لم يُسجل عليها أي نشاط تواصل.', b.neverContacted, 'created', '') +
      fuSection('ردوا ولم تتم متابعة الرد', 'حالة الرد "رد العميل" بدون موعد متابعة مستحق.', b.repliedNotFollowed, 'followUpDate', '') +
      fuSection('محوّلون للإدارة', 'تحتاج متابعة إدارية/قرار.', b.forwarded, 'followUpDate', '') +
      fuSection('اجتماعات قادمة', 'اجتماعات محددة بتاريخ اليوم أو لاحقًا.', b.meetings, 'meetingDate', '');
    updateAlertBadge(b);
  }

  function updateAlertBadge(buckets) {
    var b = buckets || C.followupBuckets(db.companies, today());
    var n = b.overdue.length;
    var badgeEl = $('followBadge');
    if (badgeEl) { badgeEl.textContent = n ? String(n) : ''; badgeEl.style.display = n ? 'inline-block' : 'none'; }
    var banner = $('alertBanner');
    if (banner) {
      if (n) {
        banner.hidden = false;
        banner.innerHTML = '⚠️ لديك <b>' + n + '</b> متابعة متأخرة. <button class="btn s" data-act="goFollowups">فتح مركز المتابعة</button>';
      } else {
        banner.hidden = true;
        banner.innerHTML = '';
      }
    }
  }


  /* ------------------------------------------------------------------ *
   * Sales plans (one independent plan per company)
   * ------------------------------------------------------------------ */

  function renderPlanSelect() {
    var sel = $('planCo');
    if (!sel) return;
    var cur = sel.value || planCompanyId;
    sel.innerHTML = db.companies.length ? db.companies.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('') : '<option value="">— ضيف شركة الأول —</option>';
    if (cur && companyOf(cur)) sel.value = cur;
    planCompanyId = sel.value || '';
    loadPlanForCompany(false);
  }

  function defaultFollowUp() {
    return C.FOLLOWUP_DAYS.map(function (f) { return { day: f.day, action: f.action }; });
  }

  function emptyPlan() {
    return {
      companySummary: '', whySelected: '', service: '', angle: '', firstContactGoal: '', openingMessage: '',
      discoveryQuestions: [], presentation: '', objections: [], cta: '', followUp: defaultFollowUp(), needs: []
    };
  }

  function fillPlanForm(plan) {
    var p = plan || emptyPlan();
    $('planSummary').value = p.companySummary || '';
    $('planWhy').value = p.whySelected || '';
    $('planService').value = p.service || '';
    $('planAngle').value = p.angle || '';
    $('planGoal').value = p.firstContactGoal || '';
    $('planMessage').value = p.openingMessage || '';
    $('planQuestions').value = (p.discoveryQuestions || []).join('\n');
    $('planPresentation').value = p.presentation || '';
    $('planObjections').value = (p.objections || []).map(function (o) { return o.objection + ' | ' + (o.response || ''); }).join('\n');
    $('planCta').value = p.cta || '';
    $('planFollowBody').innerHTML = (p.followUp && p.followUp.length ? p.followUp : defaultFollowUp()).map(function (f) {
      return '<tr><td>اليوم ' + esc(f.day) + '</td><td><textarea data-plan-day="' + esc(f.day) + '" rows="2">' + esc(f.action) + '</textarea></td></tr>';
    }).join('');
    var needs = p.needs || [];
    [].forEach.call($('needs').querySelectorAll('input'), function (i) { i.checked = needs.indexOf(i.value) > -1; });
    $('planPreview').textContent = p.text || C.planToText(p);
    $('planMeta').textContent = p.updated ? 'آخر حفظ: ' + p.updated : 'خطة غير محفوظة — ولّدها ثم احفظها.';
  }

  function loadPlanForCompany(force) {
    var id = $('planCo').value;
    if (!id) { planCompanyId = ''; fillPlanForm(null); return; }
    if (!force && planDirty) {
      if (!confirm('في تعديلات غير محفوظة على الخطة الحالية. تحب تسيبها؟')) {
        $('planCo').value = planCompanyId;
        return;
      }
    }
    planCompanyId = id;
    planDirty = false;
    var stored = planOf(id);
    var c = companyOf(id);
    if (stored) fillPlanForm(stored);
    else {
      var blank = emptyPlan();
      if (c) {
        blank.companySummary = [c.name, c.sector || c.industry || 'قطاع غير محدد', c.country || c.targetMarket || 'سوق غير محدد'].join(' — ') + '.';
        blank.angle = c.salesAngle || C.sectorModel(c.sector).angle;
      }
      fillPlanForm(blank);
      $('planMeta').textContent = 'مفيش خطة محفوظة لهذه الشركة — اضغط "توليد الخطة".';
    }
  }

  function readPlanForm() {
    var id = $('planCo').value;
    var c = companyOf(id);
    var plan = {
      version: 2,
      companyId: id,
      companyName: c ? c.name : '',
      opportunityType: c ? (c.opportunityType || 'عميل محتمل') : 'عميل محتمل',
      companySummary: $('planSummary').value.trim(),
      whySelected: $('planWhy').value.trim(),
      service: $('planService').value.trim(),
      angle: $('planAngle').value.trim(),
      firstContactGoal: $('planGoal').value.trim(),
      openingMessage: $('planMessage').value.trim(),
      discoveryQuestions: $('planQuestions').value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean),
      presentation: $('planPresentation').value.trim(),
      objections: $('planObjections').value.split(/\r?\n/).map(function (line) {
        if (!line.trim()) return null;
        var parts = line.split('|');
        return { objection: (parts[0] || '').trim(), response: (parts.slice(1).join('|') || '').trim() };
      }).filter(Boolean),
      cta: $('planCta').value.trim(),
      followUp: [].map.call($('planFollowBody').querySelectorAll('[data-plan-day]'), function (el) {
        return { day: num(el.getAttribute('data-plan-day')), action: el.value.trim() };
      }),
      needs: [].filter.call($('needs').querySelectorAll('input'), function (i) { return i.checked; }).map(function (i) { return i.value; }),
      updated: today()
    };
    plan.text = C.planToText(plan);
    return plan;
  }

  function generatePlan() {
    if (planDirty && !confirm('هيتم استبدال التعديلات الحالية في النموذج بخطة مولّدة جديدة. تكمل؟')) return;
    var c = companyOf($('planCo').value);
    if (!c) { alert('اختار شركة الأول.'); return; }
    var needs = [].filter.call($('needs').querySelectorAll('input'), function (i) { return i.checked; }).map(function (i) { return i.value; });
    var plan = C.generateSalesPlan(c, { needs: needs, fit: fitFor(c), weights: db.settings.fitWeights });
    fillPlanForm(plan);
    planDirty = true;
    toast('تم توليد خطة مستقلة لـ ' + c.name + '. راجعها ثم احفظها.', 'ok');
  }

  function savePlan() {
    var id = $('planCo').value;
    var c = companyOf(id);
    if (!c) { alert('اختار شركة الأول.'); return; }
    var plan = readPlanForm();
    db.plans[id] = plan;
    planDirty = false;
    save(); renderPlans(); renderPerformance();
    toast('تم حفظ خطة ' + c.name + ' بشكل مستقل.', 'ok');
  }

  function copyPlan() {
    var t = $('planPreview');
    var txt = t ? t.textContent : '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('تم نسخ نص الخطة.', 'ok'); }, function () { alert('تعذّر النسخ التلقائي.'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('تم نسخ نص الخطة.', 'ok'); } catch (e) { alert('تعذّر النسخ.'); }
      document.body.removeChild(ta);
    }
  }

  function renderPlans() {
    if (!db.companies.length) {
      $('planCo').innerHTML = '<option value="">— ضيف شركة الأول —</option>';
      fillPlanForm(null);
      return;
    }
    var cur = $('planCo').value;
    if (!cur || !companyOf(cur)) {
      $('planCo').innerHTML = db.companies.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
      planCompanyId = $('planCo').value;
      loadPlanForCompany(false);
      return;
    }
    $('planCo').innerHTML = db.companies.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    if (!planDirty) loadPlanForCompany(false);
  }

  function openPlanFor(id) {
    var c = companyOf(id);
    if (!c) return;
    planDirty = false;
    switchTab('plans');
    var sel = $('planCo');
    if (!Array.from(sel.options).some(function (o) { return o.value === id; })) {
      sel.innerHTML += '<option value="' + esc(id) + '">' + esc(c.name) + '</option>';
    }
    sel.value = id;
    loadPlanForCompany(true);
  }

  /* ------------------------------------------------------------------ *
   * Dashboard
   * ------------------------------------------------------------------ */

  function periodRange() {
    var p = $('dashPreset').value;
    if (p === 'all') return { from: '', to: '' };
    if (p === 'custom') return { from: $('dashFrom').value, to: $('dashTo').value };
    var t = today();
    if (p === 'month') return { from: t.slice(0, 7) + '-01', to: t };
    if (p === '30') return { from: addDays(t, -30), to: t };
    if (p === '90') return { from: addDays(t, -90), to: t };
    return { from: '', to: '' };
  }

  function barList(items, color) {
    if (!items || !items.length) return '<div class="note">مفيش بيانات.</div>';
    var max = Math.max.apply(null, items.map(function (x) { return x.count; }).concat([1]));
    return items.map(function (x) {
      var pct = Math.round(x.count / max * 100);
      return '<div class="bar-row"><span class="bar-label">' + esc(x.name) + '</span>' +
        '<div class="bb"><i style="width:' + pct + '%;background:' + (color || 'var(--t)') + '"></i></div>' +
        '<b>' + esc(x.count) + '</b></div>';
    }).join('');
  }

  function convCard(title, conv) {
    var body;
    if (!conv || !conv.available) {
      body = '<div class="conv-value muted">بيانات غير كافية</div><div class="row-sub">المقام صفر — لا توجد عينة صالحة.</div>';
    } else {
      body = '<div class="conv-value">' + conv.rate + '%</div>' +
        '<div class="row-sub">' + conv.numerator + ' ÷ ' + conv.denominator + ' = ' + conv.rate + '%</div>' +
        (conv.smallSample ? '<div class="row-sub warn">عينة صغيرة (أقل من 5) — النسبة غير مستقرة.</div>' : '');
    }
    return '<div class="conv"><b>' + esc(title) + '</b>' + body +
      '<small>' + esc(conv ? conv.definition : '') + '</small></div>';
  }

  function rateCell(conv) {
    if (!conv || !conv.available) return '<span class="muted">بيانات غير كافية</span>';
    return esc(conv.rate) + '%' + (conv.smallSample ? '<div class="row-sub warn">عينة صغيرة</div>' : '');
  }

  function renderDashboard() {
    var range = periodRange();
    var m = C.dashboardMetrics(db.companies, { weights: db.settings.fitWeights, from: range.from, to: range.to });
    $('dashCards').innerHTML = [
      card('إجمالي الشركات', esc(m.total)),
      card('HOT / WARM / COLD', '<span style="color:#ff6b6b">' + (m.classified.HOT || 0) + '</span> / <span style="color:#ffc400">' + (m.classified.WARM || 0) + '</span> / <span style="color:#58bec6">' + (m.classified.COLD || 0) + '</span>'),
      card('صفقات مفتوحة', esc(m.openDeals)),
      card('مكتسبة', esc(m.wonDeals)),
      card('خاسرة', esc(m.lostDeals)),
      card('قيمة المفتوح', valueLines(m.openValueList)),
      card('قيمة المكتسب', valueLines(m.wonValueList)),
      card('Pipeline مرجّح', valueLines(m.weightedList))
    ].join('');
    $('dashSector').innerHTML = barList(m.sectors);
    $('dashCountry').innerHTML = barList(m.countries);
    $('dashStages').innerHTML = barList(m.stages.filter(function (s) { return s.count > 0; }), 'var(--y)');
    $('dashConversions').innerHTML =
      convCard('من التواصل إلى الاهتمام', m.conversions.contactToInterest) +
      convCard('من الاهتمام إلى عرض السعر', m.conversions.interestToQuote) +
      convCard('من عرض السعر إلى الإغلاق', m.conversions.quoteToWon) +
      convCard('معدل الإغلاق (Won ÷ Won+Lost)', m.conversions.winRate);
    $('dashQuality').innerHTML = 'الشركات المستبعدة لعدم وجود تاريخ إضافة: <b>' + m.excludedUndated + '</b> · ' +
      'شركات خاسرة/غير مناسبة بدون سجل مراحل (مستبعدة من قمع التحويل): <b>' + m.unknownFunnel + '</b>. ' +
      'المبالغ لا تُجمع بين عملات مختلفة؛ كل عملة تظهر منفصلة.';
    $('dashCampaigns').innerHTML = m.campaigns.length ? m.campaigns.map(function (x) {
      return '<tr><td><b>' + esc(x.name) + '</b></td><td>' + x.total + '</td><td>' + x.contacted + '</td><td>' + x.replied +
        '</td><td>' + x.interested + '</td><td>' + x.quotes + '</td><td>' + x.won +
        '</td><td>' + rateCell(x.contactedToReplied) + '</td><td>' + rateCell(x.contactedToInterested) + '</td></tr>';
    }).join('') : '<tr><td colspan="9" class="empty">مفيش حملات مرتبطة بشركات.</td></tr>';
    $('dashSources').innerHTML = m.sources.length ? m.sources.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + x.total + '</td><td>' + x.won + '</td><td>' + x.lost + '</td><td>' + rateCell(x.winRate) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">مفيش بيانات.</td></tr>';
    $('dashSectors').innerHTML = m.sectorPerformance.length ? m.sectorPerformance.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + x.total + '</td><td>' + x.open + '</td><td>' + x.won + '</td><td>' + x.lost + '</td><td>' + rateCell(x.winRate) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">مفيش بيانات.</td></tr>';
    $('dashFrom').style.display = $('dashPreset').value === 'custom' ? '' : 'none';
    $('dashTo').style.display = $('dashPreset').value === 'custom' ? '' : 'none';
  }

  /* ------------------------------------------------------------------ *
   * Campaigns
   * ------------------------------------------------------------------ */

  function allCampaignNames() {
    var names = db.campaigns.map(function (c) { return c.name; });
    db.companies.forEach(function (c) { if (c.campaign && names.indexOf(c.campaign) < 0) names.push(c.campaign); });
    return names;
  }

  function refreshCampaignOptions() {
    var names = allCampaignNames();
    var dl = $('campaignList');
    if (dl) dl.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    var filter = $('fcampaign');
    if (filter) {
      var cur = filter.value;
      filter.innerHTML = '<option value="">كل الحملات</option>' + names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    }
  }

  function renderCampaigns() {
    refreshCampaignOptions();
    var metrics = C.campaignMetrics(db.companies, db.settings.fitWeights);
    var map = {};
    metrics.forEach(function (x) { map[x.name] = x; });
    var names = allCampaignNames();
    $('campaignTable').innerHTML = names.length ? names.map(function (name) {
      var x = map[name] || { total: 0, contacted: 0, replied: 0, interested: 0, quotes: 0, won: 0, lost: 0, openValueList: [] };
      var registered = db.campaigns.some(function (c) { return c.name === name; });
      return '<tr><td><b>' + esc(name) + '</b>' + (registered ? '' : '<div class="row-sub warn">غير مسجلة في قائمة الحملات</div>') + '</td>' +
        '<td>' + x.total + '</td><td>' + x.contacted + '</td><td>' + x.replied + '</td><td>' + x.interested +
        '</td><td>' + x.quotes + '</td><td>' + x.won + '</td><td>' + x.lost + '</td><td>' + valueLines(x.openValueList) +
        '</td><td>' + rateCell(x.contactedToInterested) + '</td>' +
        '<td><div class="act"><button class="btn s" data-act="campaignRename" data-name="' + esc(name) + '">تعديل الاسم</button>' +
        '<button class="btn d" data-act="campaignDelete" data-name="' + esc(name) + '">حذف</button></div></td></tr>';
    }).join('') : '<tr><td colspan="11" class="empty">لسه مفيش حملات. أضف حملة من النموذج بالأعلى.</td></tr>';
  }

  function addCampaign(e) {
    e.preventDefault();
    var name = $('cName').value.trim();
    if (!name) { alert('اسم الحملة مطلوب.'); return; }
    if (db.campaigns.some(function (c) { return c.name === name; })) { alert('فيه حملة بنفس الاسم.'); return; }
    db.campaigns.push(C.normalizeCampaign({ name: name, source: $('cSource').value, notes: $('cNotes').value.trim() }));
    $('cName').value = ''; $('cNotes').value = '';
    save(); renderAll();
    toast('تمت إضافة الحملة.', 'ok');
  }

  function renameCampaign(oldName) {
    var newName = prompt('الاسم الجديد للحملة:', oldName);
    if (newName == null) return;
    newName = newName.trim();
    if (!newName || newName === oldName) return;
    if (db.campaigns.some(function (c) { return c.name === newName; })) { alert('الاسم مستخدم بالفعل.'); return; }
    var affected = db.companies.filter(function (c) { return c.campaign === oldName; }).length;
    if (!confirm('سيتم تغيير اسم الحملة' + (affected ? ' وتحديث ' + affected + ' شركة مرتبطة بها' : '') + '. متأكد؟')) return;
    db.campaigns.forEach(function (c) { if (c.name === oldName) c.name = newName; });
    db.companies.forEach(function (c) { if (c.campaign === oldName) c.campaign = newName; });
    save(); renderAll();
    toast('تم تعديل اسم الحملة.', 'ok');
  }

  function deleteCampaign(name) {
    var used = db.companies.filter(function (c) { return c.campaign === name; }).length;
    if (used) { alert('لا يمكن حذف حملة مرتبطة بـ ' + used + ' شركة. أعد تسميتها أو غيّر حملة الشركات أولًا.'); return; }
    if (!confirm('تمسح الحملة "' + name + '" من القائمة؟')) return;
    db.campaigns = db.campaigns.filter(function (c) { return c.name !== name; });
    save(); renderAll();
    toast('تم حذف الحملة.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  function hydrateSettings() {
    var w = db.settings.fitWeights;
    $('wService').value = w.service;
    $('wCommercial').value = w.commercial;
    $('wOpportunity').value = w.opportunity;
    $('wMarket').value = w.market;
    $('wAccess').value = w.access;
    settingsHydrated = true;
    updateWeightSum();
  }

  function updateWeightSum() {
    var total = ['wService', 'wCommercial', 'wOpportunity', 'wMarket', 'wAccess'].reduce(function (s, id) { return s + num($(id).value); }, 0);
    $('weightSum').textContent = 'المجموع: ' + total + ' (يُفضّل 100)';
    $('weightSum').className = total === 100 ? 'ok' : 'warn';
  }

  function saveWeights() {
    var w = {
      service: num($('wService').value),
      commercial: num($('wCommercial').value),
      opportunity: num($('wOpportunity').value),
      market: num($('wMarket').value),
      access: num($('wAccess').value)
    };
    if (Object.keys(w).some(function (k) { return w[k] < 0; })) { alert('الأوزان لا تكون سالبة.'); return; }
    if (w.service + w.commercial + w.opportunity + w.market + w.access <= 0) { alert('لازم وزن واحد على الأقل أكبر من صفر.'); return; }
    if (!confirm('تغيير الأوزان يعيد حساب Fit Score لكل الشركات. متأكد؟')) return;
    db.settings.fitWeights = C.normalizeWeights(w).weights;
    save(); renderAll();
    toast('تم حفظ أوزان التقييم.', 'ok');
  }

  function resetWeights() {
    if (!confirm('رجوع الأوزان الافتراضية (30/20/20/15/15)؟')) return;
    db.settings.fitWeights = JSON.parse(JSON.stringify(C.DEFAULT_FIT_WEIGHTS));
    hydrateSettings(); save(); renderAll();
  }

  function renderSettings() {
    if (!settingsHydrated) hydrateSettings();
    var legacy = db.companies.filter(function (c) { return c.fitMode !== 'components' && c.fitScore !== '' && c.fitScore != null; }).length;
    var m = C.dashboardMetrics(db.companies, { weights: db.settings.fitWeights });
    $('diagnostics').innerHTML = [
      ['الشركات', db.companies.length],
      ['الخطط المحفوظة', Object.keys(db.plans).filter(function (id) { return !!db.plans[id]; }).length],
      ['الحملات', db.campaigns.length],
      ['المنشورات', db.posts.length],
      ['شركات بدرجة قديمة غير مُعاد تقييمها', legacy],
      ['شركات بدون تاريخ إضافة', m.excludedUndated],
      ['خاسرة/غير مناسبة بدون سجل مراحل', m.unknownFunnel],
      ['حالة السحابة', cloudReady ? 'متصل' : 'غير متصل'],
      ['حالة التخزين المحلي', (function () { try { localStorage.getItem(KEY); return 'متاح'; } catch (e) { return 'غير متاح'; } })()]
    ].map(function (x) {
      return '<div class="diag-row"><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>';
    }).join('');
  }


  /* ------------------------------------------------------------------ *
   * Posts (preserved existing CRM)
   * ------------------------------------------------------------------ */

  function cCount(p) {
    var n = parseInt(p.commentsCount, 10);
    if (!isNaN(n) && p.commentsCount !== '' && p.commentsCount != null) return n;
    return p.comments ? String(p.comments).split(/\r?\n/).filter(function (x) { return x.trim(); }).length : 0;
  }
  function eng(p) { return num(p.likes) + 3 * cCount(p); }
  function maxEng() {
    var m = 0;
    db.posts.forEach(function (p) { var e = eng(p); if (e > m) m = e; });
    return m;
  }
  function pScore(p, m) { return m ? Math.round(eng(p) / m * 100) : 0; }
  function complete(c) {
    var f = [c.name, c.website, c.contact, c.phone, c.industry, c.source,
      (c.facebook || c.instagram || c.linkedin), c.employees, c.annualRevenueEstimate, c.estimateBasis];
    var n = 0;
    f.forEach(function (x) { if (x !== '' && x != null) n++; });
    return Math.round(n / 10 * 100);
  }
  function social(c) {
    var m = maxEng();
    var a = db.posts.filter(function (p) { return String(p.page).toLowerCase() === String(c.name).toLowerCase(); });
    if (!a.length) return null;
    var s = 0;
    a.forEach(function (p) { s += pScore(p, m); });
    return Math.round(s / a.length);
  }
  function total(c) {
    var d = complete(c);
    var p = C.dealProgress(c.stage);
    var s = social(c);
    return s === null ? Math.round(d * 0.4 + p * 0.6) : Math.round(d * 0.3 + p * 0.4 + s * 0.3);
  }

  function renderPosts() {
    var L = db.posts, m = maxEng(), lk = 0, cm = 0;
    L.forEach(function (p) { lk += num(p.likes); cm += cCount(p); });
    $('pStats').innerHTML = [
      card('عدد المنشورات', L.length),
      card('إجمالي الايكات', fmt(lk)),
      card('إجمالي الكومنتات', fmt(cm)),
      card('متوسط الايكات', L.length ? Math.round(lk / L.length) : 0)
    ].join('');
    var q = $('pq').value.trim().toLowerCase(), pf = $('pf').value;
    var F = L.filter(function (p) {
      if (pf && p.platform !== pf) return false;
      return !q || [p.page, p.title, p.comments].join(' ').toLowerCase().indexOf(q) > -1;
    });
    $('tbP').innerHTML = F.length ? F.map(function (p, i) {
      var n = cCount(p);
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.platform) + '</td><td>' + esc(p.page) + '</td><td><b>' +
        (p.link ? '<a style="color:var(--y)" target="_blank" rel="noopener" href="' + esc(p.link) + '">' + esc(p.title) + '</a>' : esc(p.title)) +
        '</b></td><td>' + fmt(num(p.likes)) + '</td><td>' + n + '</td><td>' +
        (p.comments ? '<details><summary>عرض (' + n + ')</summary><div>' + esc(p.comments) + '</div></details>' : '-') +
        '</td><td>' + esc(p.date) + '</td><td><div class="act"><button class="btn s" data-act="eP" data-id="' + esc(p.id) + '">تعديل</button>' +
        '<button class="btn d" data-act="dP" data-id="' + esc(p.id) + '">حذف</button></div></td></tr>';
    }).join('') : '<tr><td colspan="9" class="empty">' + (L.length ? 'مفيش نتائج.' : 'لسه مفيش منشورات. دوس "إضافة منشور".') + '</td></tr>';
  }

  var FC_POSTS = [
    { k: 'platform', l: 'المنصة', t: 'select', o: ['فيسبوك', 'انستجرام'] },
    { k: 'page', l: 'الصفحة / الشركة *', req: 1 },
    { k: 'title', l: 'اسم المنشور *', req: 1, full: 1 },
    { k: 'likes', l: 'عدد الايكات', t: 'number' },
    { k: 'commentsCount', l: 'عدد الكومنتات (اختياري)', t: 'number' },
    { k: 'link', l: 'رابط المنشور', full: 1 },
    { k: 'date', l: 'التاريخ', t: 'date' },
    { k: 'comments', l: 'نص الكومنتات (كل كومنت في سطر)', t: 'textarea', full: 1, r: 5 }
  ];

  var formCallback = null;
  function genericForm(title, fields, vals, fn) {
    $('dT').textContent = title;
    $('dF').innerHTML = fields.map(function (f) {
      var input = f.t === 'select' ? '<select name="' + f.k + '">' + opts(f.o, '') + '</select>' :
        f.t === 'textarea' ? '<textarea name="' + f.k + '" rows="' + (f.r || 3) + '"></textarea>' :
          '<input name="' + f.k + '" type="' + (f.t || 'text') + '"' + (f.req ? ' required' : '') + (f.step ? ' step="any"' : '') + '>';
      return '<label class="' + (f.full ? 'full' : '') + '">' + esc(f.l) + input + '</label>';
    }).join('');
    var el = $('frm').elements;
    fields.forEach(function (f) {
      el[f.k].value = vals && vals[f.k] != null ? vals[f.k] : (f.t === 'select' ? f.o[0] : '');
    });
    formCallback = function () {
      var o = {};
      fields.forEach(function (f) { o[f.k] = el[f.k].value.trim ? el[f.k].value.trim() : el[f.k].value; });
      fn(o);
    };
    $('dlg').showModal();
  }

  function editPost(id) {
    var p = id ? byId(db.posts, id) : null;
    genericForm(p ? 'تعديل منشور' : 'إضافة منشور', FC_POSTS, p, function (o) {
      if (!o.page || !o.title) return;
      if (p) { for (var k in o) p[k] = o[k]; }
      else { o.id = C.uid(); db.posts.push(o); }
      save(); renderAll();
    });
  }

  /* ------------------------------------------------------------------ *
   * Performance (existing view, adapted to the new stages)
   * ------------------------------------------------------------------ */

  function renderPerformance() {
    var m = maxEng();
    $('tbPerfC').innerHTML = db.companies.length ? db.companies.map(function (c) {
      var s = social(c);
      return '<tr><td><b>' + esc(c.name) + '</b></td><td>' + esc(c.stage) + '</td><td>' + bar2(complete(c)) +
        '</td><td>' + bar2(C.dealProgress(c.stage)) + '</td><td>' + (s === null ? '<span class="muted">مفيش منشورات</span>' : bar2(s)) +
        '</td><td>' + bar2(total(c)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">مفيش شركات.</td></tr>';
    var P = db.posts.slice().sort(function (a, b) { return eng(b) - eng(a); });
    $('tbPerfP').innerHTML = P.length ? P.map(function (p) {
      return '<tr><td>' + esc(p.platform) + '</td><td>' + esc(p.page) + '</td><td>' + esc(p.title) + '</td><td>' +
        fmt(num(p.likes)) + '</td><td>' + cCount(p) + '</td><td>' + bar2(pScore(p, m)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">مفيش منشورات.</td></tr>';
    var stageCounts = C.STAGE_KEYS.map(function (stage) {
      return { name: stage, count: db.companies.filter(function (c) { return c.stage === stage; }).length };
    });
    $('pipelineChart').innerHTML = barList(stageCounts.filter(function (s) { return s.count > 0; }));
    var mtr = C.dashboardMetrics(db.companies, { weights: db.settings.fitWeights });
    $('sourcePerf').innerHTML = mtr.sources.length ? mtr.sources.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + x.total + '</td><td>' + x.won + '</td><td>' + rateCell(x.winRate) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">مفيش بيانات مصادر كفاية.</td></tr>';
    $('campaignPerf').innerHTML = mtr.campaigns.length ? mtr.campaigns.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + x.total + '</td><td>' + x.won + '</td><td>' + rateCell(x.quoteToWon) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">سجّل اسم الحملة في ملف الشركة لعرض التحليل.</td></tr>';
  }
  function bar2(v) {
    var color = v < 40 ? 'var(--r)' : v < 70 ? 'var(--y)' : 'var(--t)';
    return '<div class="bw"><div class="bb"><i style="width:' + v + '%;background:' + color + '"></i></div><b>' + v + '%</b></div>';
  }

  /* ------------------------------------------------------------------ *
   * CSV export
   * ------------------------------------------------------------------ */

  function cc(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function csv(head, rows) {
    return '\uFEFF' + [head.map(cc).join(',')].concat(rows.map(function (r) { return r.map(cc).join(','); })).join('\r\n');
  }
  function download(name, txt, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function companyExportRows() {
    var head = ['الشركة', 'المسؤول', 'المنصب', 'الرقم', 'واتساب', 'المجال', 'القطاع', 'الدولة', 'السوق المستهدف',
      'عدد الموظفين', 'المبيعات السنوية التقديرية', 'العملة', 'مستوى الثقة في التقدير', 'أساس التقدير ومصدره',
      'المصدر', 'الحملة', 'المرحلة', 'حالة الرد', 'قيمة الصفقة', 'احتمالية الإغلاق %', 'المسؤول عن المتابعة',
      'موعد المتابعة', 'موعد الاجتماع', 'آخر تواصل', 'سبب الخسارة', 'الموقع الإلكتروني', 'Facebook', 'Instagram', 'LinkedIn',
      'نوع الفرصة', 'الأولوية', 'Fit Score', 'Fit Confidence', 'التصنيف',
      'ملاءمة الخدمة', 'الإمكانية التجارية', 'درجة الفرصة', 'ملاءمة السوق', 'سهولة الوصول',
      'الفرصة الملحوظة', 'المشكلة المحتملة', 'زاوية البيع', 'ملخص البحث', 'مصادر البحث', 'آخر تحديث للتحليل',
      'ملاحظات', 'تاريخ الإضافة', 'اكتمال البيانات %', 'تقدم الصفقة %', 'الإجمالي %'];
    var rows = db.companies.map(function (c) {
      var fit = fitFor(c);
      var comp = {};
      (fit.components || []).forEach(function (x) { comp[x.key] = x.value; });
      return [c.name, c.contact, c.contactRole, c.phone, c.whatsapp, c.industry, c.sector, c.country, c.targetMarket,
        c.employees, c.annualRevenueEstimate, c.currency, c.revenueConfidence, c.estimateBasis,
        c.source, c.campaign, c.stage, c.replyStatus, c.value, C.dealProbability(c), c.owner,
        c.followUpDate, c.meetingDate, c.lastContactAt ? String(c.lastContactAt).slice(0, 10) : '', c.lostReason,
        c.website, c.facebook, c.instagram, c.linkedin,
        c.opportunityType, c.priority, fit.score, fit.confidence, fit.classification,
        comp.service != null ? comp.service : '', comp.commercial != null ? comp.commercial : '',
        comp.opportunity != null ? comp.opportunity : '', comp.market != null ? comp.market : '', comp.access != null ? comp.access : '',
        c.observedOpportunity, c.problem, c.salesAngle, c.researchSummary,
        (c.researchSources || []).map(function (s) { return s.label + (s.url ? ' | ' + s.url : ''); }).join(' ; '),
        c.researchUpdatedAt, c.notes, c.created, complete(c), C.dealProgress(c.stage), total(c)];
    });
    return { head: head, rows: rows };
  }

  function reportText() {
    var m = maxEng();
    var L = ['تقرير Digital Reach — ' + today(), 'عدد الشركات: ' + db.companies.length + ' | عدد المنشورات: ' + db.posts.length, '', '== الشركات =='];
    db.companies.forEach(function (c) {
      var fit = fitFor(c);
      var s = social(c);
      L.push(c.name + ' | ' + c.stage + ' | Fit ' + fit.score + ' (' + (fit.classification || '—') + ') | بيانات ' + complete(c) +
        '% | صفقة ' + C.dealProgress(c.stage) + '% | سوشيال ' + (s === null ? '—' : s + '%') + ' | إجمالي ' + total(c) + '%');
    });
    L.push('', '== المنشورات (الأعلى تفاعلًا أولًا) ==');
    db.posts.slice().sort(function (a, b) { return eng(b) - eng(a); }).forEach(function (p) {
      L.push('[' + p.platform + '] ' + p.page + ' — ' + p.title + ' | ايكات ' + num(p.likes) + ' | كومنتات ' + cCount(p) + ' | مؤشر تفاعل نسبي ' + pScore(p, m) + '%');
    });
    L.push('', 'ملحوظة: النسب مؤشرات داخلية مبنية على البيانات المسجلة، وليست ضمان نتائج.');
    return L.join('\n');
  }

  function handleDownload(kind) {
    var d = today();
    if (kind === 'companies') {
      var ex = companyExportRows();
      download('sales-crm-' + d + '.csv', csv(ex.head, ex.rows), 'text/csv;charset=utf-8');
    }
    if (kind === 'campaigns') {
      var mtr = C.dashboardMetrics(db.companies, { weights: db.settings.fitWeights });
      download('campaigns-' + d + '.csv', csv(['الحملة', 'الشركات', 'تم التواصل', 'ردوا', 'مهتم', 'عروض سعر', 'مكتسبة', 'خاسرة', 'معدل الرد %', 'معدل الاهتمام %'],
        mtr.campaigns.map(function (x) {
          return [x.name, x.total, x.contacted, x.replied, x.interested, x.quotes, x.won, x.lost,
            x.contactedToReplied.available ? x.contactedToReplied.rate : 'بيانات غير كافية',
            x.contactedToInterested.available ? x.contactedToInterested.rate : 'بيانات غير كافية'];
        })), 'text/csv;charset=utf-8');
    }
    if (kind === 'posts') {
      var m = maxEng();
      download('posts-crm-' + d + '.csv', csv(['المنصة', 'الصفحة', 'اسم المنشور', 'الايكات', 'عدد الكومنتات', 'نص الكومنتات', 'الرابط', 'التاريخ', 'نسبة التفاعل %'],
        db.posts.map(function (p) { return [p.platform, p.page, p.title, p.likes, cCount(p), p.comments, p.link, p.date, pScore(p, m)]; })), 'text/csv;charset=utf-8');
    }
    if (kind === 'plans') {
      var texts = [];
      db.companies.forEach(function (c) {
        var p = planOf(c.id);
        if (p) texts.push(p.text || C.planToText(p));
      });
      if (!texts.length) { alert('مفيش خطط محفوظة'); return; }
      download('plans-' + d + '.txt', texts.join('\n\n==============================\n\n'), 'text/plain;charset=utf-8');
    }
    if (kind === 'report') download('report-' + d + '.txt', reportText(), 'text/plain;charset=utf-8');
    if (kind === 'backup') download('digital-reach-backup-' + d + '.json', JSON.stringify(db, null, 2), 'application/json');
  }

  /* ------------------------------------------------------------------ *
   * CSV import with review step
   * ------------------------------------------------------------------ */

  function analyzeImport() {
    var f = $('upF').files[0];
    if (!f) { $('upMsg').textContent = 'اختار ملف الأول.'; return; }
    var target = $('upT').value;
    var reader = new FileReader();
    reader.onload = function () {
      var rows = C.parseCSV(String(reader.result));
      if (rows.length < 2) { $('upMsg').textContent = 'الملف فاضي أو مفيش فيه صفوف بيانات.'; return; }
      if (target === 'posts') { importPosts(rows); return; }
      pendingImport = C.buildImportPlan(rows, db.companies);
      if (pendingImport.error) {
        $('upMsg').textContent = pendingImport.error;
        $('importPreview').innerHTML = '';
        $('applyImport').disabled = true;
        return;
      }
      $('upMsg').textContent = 'تم تحليل الملف. راجع النتائج بالأسفل ثم اعتمد الاستيراد. لا يوجد حذف أو استبدال لأي بيانات موجودة.';
      renderImportPreview();
      $('applyImport').disabled = false;
    };
    reader.readAsText(f, 'UTF-8');
  }

  function actionOptions(item) {
    var options = [];
    if (item.action === 'new') options = [['new', 'إضافة كشركة جديدة'], ['skip', 'تخطي']];
    else if (item.action === 'update') options = [['update', 'تحديث الحقول الفاضية'], ['skip', 'تخطي']];
    else if (item.action === 'duplicate') options = [['duplicate', 'مطابقة — بدون تغيير'], ['skip', 'تخطي']];
    else if (item.action === 'review') {
      options = [['skip', 'تخطي (افتراضي)'], ['new', 'إضافة كشركة جديدة']];
      if (item.matchId) options.splice(1, 0, ['update', 'تحديث السجل المطابق']);
    }
    return options.map(function (o) {
      return '<option value="' + o[0] + '"' + (item.action === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
  }

  function renderImportPreview() {
    var p = pendingImport;
    if (!p) { $('importPreview').innerHTML = ''; return; }
    var changesLabel = function (item) {
      if (item.action === 'update' && item.changes) {
        var keys = Object.keys(item.changes);
        return keys.length ? 'حقول: ' + keys.slice(0, 6).join('، ') + (keys.length > 6 ? '…' : '') : 'لا تغييرات';
      }
      return '';
    };
    $('importPreview').innerHTML =
      '<div class="import-summary">' +
      '<span class="badge" style="--bc:#4ade80">جديد: ' + p.counts.new + '</span>' +
      '<span class="badge" style="--bc:#58bec6">تحديث: ' + p.counts.update + '</span>' +
      '<span class="badge" style="--bc:#aab3d1">مطابق: ' + p.counts.duplicate + '</span>' +
      '<span class="badge" style="--bc:#ffc400">يحتاج مراجعة: ' + p.counts.review + '</span>' +
      '<span class="badge" style="--bc:#ff6b6b">متخطى: ' + p.counts.skipped + '</span>' +
      '</div>' +
      '<div class="tw"><table><thead><tr><th>سطر</th><th>الشركة</th><th>الهاتف</th><th>الإجراء</th><th>التفاصيل</th></tr></thead><tbody>' +
      p.items.map(function (item, i) {
        return '<tr><td>' + item.rowNumber + '</td><td><b>' + esc(item.name) + '</b></td><td dir="ltr">' + esc(item.phone || '—') +
          '</td><td><select data-import-action data-index="' + i + '">' + actionOptions(item) + '</select></td>' +
          '<td class="nt">' + esc(item.reason || '') + (changesLabel(item) ? '<div class="row-sub">' + esc(changesLabel(item)) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function applyPendingImport() {
    if (!pendingImport) return;
    var decisions = [];
    [].forEach.call($('importPreview').querySelectorAll('[data-import-action]'), function (sel) {
      decisions[num(sel.getAttribute('data-index'))] = sel.value;
    });
    var willCreate = decisions.filter(function (d) { return d === 'new'; }).length;
    var willUpdate = decisions.filter(function (d) { return d === 'update'; }).length;
    if (!confirm('سيتم إضافة ' + willCreate + ' شركة وتحديث ' + willUpdate + ' شركة. لن يتم حذف أي سجل. متأكد؟')) return;
    var report = C.applyImport(db, pendingImport, decisions);
    save(); renderAll();
    $('upMsg').textContent = 'تم الاستيراد: جديد ' + report.created + ' · محدّث ' + report.updated + ' · مكرر ' + report.duplicated +
      ' · متخطى ' + report.skipped + (report.reviewAsNew ? ' · مراجعات أضيفت كجديد ' + report.reviewAsNew : '') +
      (report.reviewAsUpdate ? ' · مراجعات حدّثت سجلات ' + report.reviewAsUpdate : '') + '.';
    pendingImport = null;
    $('importPreview').innerHTML = '';
    $('applyImport').disabled = true;
    $('upF').value = '';
    toast('تم اعتماد الاستيراد.', 'ok');
  }

  function cancelPendingImport() {
    pendingImport = null;
    $('importPreview').innerHTML = '';
    $('applyImport').disabled = true;
    $('upMsg').textContent = 'تم إلغاء الاستيراد. لم يتم تغيير أي بيانات.';
  }

  function importPosts(rows) {
    var map = C.mapPostHeaders(rows[0]);
    if (map.title === undefined) { $('upMsg').textContent = 'مفيش عمود اسم المنشور في الملف.'; return; }
    var added = 0, skipped = 0, pending = [];
    rows.slice(1).forEach(function (cells) {
      var o = {};
      Object.keys(map).forEach(function (k) { var v = C.text(cells[map[k]]).trim(); if (v) o[k] = v; });
      if (!o.title) { skipped++; return; }
      if (o.platform !== 'فيسبوك' && o.platform !== 'انستجرام') {
        var s = C.text(o.platform).toLowerCase();
        o.platform = s.indexOf('insta') > -1 || s.indexOf('انستجرام') > -1 ? 'انستجرام' : 'فيسبوك';
      }
      o.page = o.page || '';
      o.id = C.uid();
      pending.push(o);
      added++;
    });
    if (!confirm('سيتم إضافة ' + added + ' منشور وتخطي ' + skipped + '. متأكد؟')) return;
    pending.forEach(function (o) { db.posts.push(o); });
    save(); renderAll();
    $('upMsg').textContent = 'تم استيراد ' + added + ' منشور، وتخطي ' + skipped + ' صف بدون بيانات كافية.';
    $('upF').value = '';
  }

  function restoreBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.companies)) throw new Error('bad backup');
        if (!confirm('هيتم استبدال البيانات الحالية بالنسخة دي. نزّل نسخة احتياطية من الوضع الحالي أولًا إن كنت غير متأكد. متأكد؟')) return;
        db = C.normalizeDb(parsed);
        save(); hydrateSettings(); renderAll();
        toast('تم استرجاع النسخة الاحتياطية.', 'ok');
      } catch (e) {
        alert('الفايل ده مش نسخة احتياطية صحيحة.');
      }
    };
    reader.readAsText(file);
  }


  /* ------------------------------------------------------------------ *
   * Tabs / rendering
   * ------------------------------------------------------------------ */

  function switchTab(tab) {
    [].forEach.call($('nav').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    var btn = $('nav').querySelector('button[data-tab="' + tab + '"]');
    if (btn) btn.classList.add('on');
    [].forEach.call(document.querySelectorAll('.panel'), function (x) { x.classList.remove('on'); });
    var panel = $('tab-' + tab);
    if (panel) panel.classList.add('on');
    if (tab === 'dashboard') renderDashboard();
    else if (tab === 'sales') renderSales();
    else if (tab === 'followups') renderFollowups();
    else if (tab === 'plans') renderPlans();
    else if (tab === 'campaigns') renderCampaigns();
    else if (tab === 'posts') renderPosts();
    else if (tab === 'perf') renderPerformance();
    else if (tab === 'settings') renderSettings();
  }

  function renderAll() {
    renderSales();
    renderPosts();
    renderPlans();
    renderPerformance();
    renderFollowups();
    renderDashboard();
    renderCampaigns();
    renderSettings();
    updateAlertBadge();
  }

  /* ------------------------------------------------------------------ *
   * Firebase auth / cloud sync
   * ------------------------------------------------------------------ */

  function showCRM() { document.body.classList.remove('auth-locked'); setAuthMessage(''); }
  function lockCRM() { cloudReady = false; document.body.classList.add('auth-locked'); }

  function initFirebase() {
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      setAuthMessage('تعذّر تحميل Firebase SDK. تأكد من الاتصال بالإنترنت ثم أعد تحميل الصفحة. البيانات المحلية محفوظة على الجهاز.');
      return;
    }
    try {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      firestore = firebase.firestore();
      cloudDoc = firestore.collection('crmData').doc('main');
    } catch (e) {
      console.error('Firebase init failed', e);
      setAuthMessage('تعذّر تهيئة Firebase: ' + (e.message || ''));
      return;
    }

    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('loginEmail').value.trim().toLowerCase();
      var password = $('loginPassword').value;
      $('loginBtn').disabled = true;
      setAuthMessage('جاري تسجيل الدخول...');
      auth.signInWithEmailAndPassword(email, password).catch(function (err) {
        $('loginBtn').disabled = false;
        var msg = err && err.code === 'auth/unauthorized-domain' ? 'الدومين غير مضاف في Firebase Authentication > Settings > Authorized domains.' :
          err && err.code === 'auth/invalid-credential' ? 'الإيميل أو كلمة المرور غير صحيحة.' :
            'تعذّر تسجيل الدخول: ' + ((err && err.message) || 'راجع إعدادات Firebase.');
        setAuthMessage(msg);
      });
    });

    $('bSignOut').addEventListener('click', function () {
      cloudReady = false;
      auth.signOut().then(lockCRM).catch(function () { setAuthMessage('تعذّر تسجيل الخروج.'); });
    });

    auth.onAuthStateChanged(async function (user) {
      lockCRM();
      $('loginBtn').disabled = false;
      if (!user) { setAuthMessage(''); return; }
      if (String(user.email || '').toLowerCase() !== ALLOWED_EMAIL) {
        await auth.signOut();
        setAuthMessage('الحساب ده مش مصرح له بالدخول.');
        return;
      }
      setAuthMessage('جاري تحميل بيانات CRM…');
      try {
        var snap = await cloudDoc.get();
        if (snap.exists) {
          var remote = snap.data() || {};
          db = C.normalizeDb(remote);
          try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore quota */ }
        } else {
          await cloudDoc.set(cloudPayload());
        }
        cloudReady = true;
        hydrateSettings();
        showCRM();
        renderAll();
        setCloudStatus('متصل بـ Firestore · ' + new Date().toLocaleTimeString('ar-EG'), 'ok');
      } catch (err) {
        console.error('Cloud load failed', err);
        setAuthMessage('تعذّر تحميل البيانات من Firestore. تأكد من نشر قواعد الحماية والاتصال بالإنترنت. البيانات المحلية لم تُحذف.');
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */

  function wireEvents() {
    $('nav').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      switchTab(b.getAttribute('data-tab'));
    });

    ['q', 'fst', 'fcls', 'fsector', 'fcountry', 'fcampaign', 'fsort'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener(id === 'q' ? 'input' : 'change', renderSales);
    });
    $('addC').addEventListener('click', function () { openCompanyForm(null); });
    $('bulkEdit').addEventListener('click', openBulkEdit);
    $('clearSelection').addEventListener('click', function () { selectedCompanyIds = {}; renderSales(); });
    $('bulkDelete').addEventListener('click', function () {
      var ids = selectedIds();
      if (!ids.length) return;
      if (!confirm('هتحذف ' + ids.length + ' شركة والخطط المرتبطة بها. العملية لا يمكن التراجع عنها. نزّل نسخة احتياطية قبل المتابعة.')) return;
      db.companies = db.companies.filter(function (c) {
        if (ids.indexOf(c.id) > -1) { delete db.plans[c.id]; return false; }
        return true;
      });
      selectedCompanyIds = {};
      save(); renderAll();
      toast('تم حذف ' + ids.length + ' شركة.', 'ok');
    });

    document.addEventListener('change', function (e) {
      var box = e.target.closest('[data-company-select]');
      if (box) {
        var id = box.getAttribute('data-company-select');
        if (box.checked) selectedCompanyIds[id] = true; else delete selectedCompanyIds[id];
        renderBulkState(filteredCompanies());
        return;
      }
      if (e.target.id === 'selectAllCompanies') {
        var list = filteredCompanies();
        list.forEach(function (c) {
          if (e.target.checked) selectedCompanyIds[c.id] = true; else delete selectedCompanyIds[c.id];
        });
        renderSales();
        return;
      }
      var s = e.target.closest('[data-stg]');
      if (s) {
        var c = companyOf(s.getAttribute('data-stg'));
        if (c) {
          if (!C.recordStageChange(c, s.value)) c.stage = s.value;
          save(); renderAll();
        }
        return;
      }
      if (e.target.closest('#tab-plans') && e.target.id !== 'planCo') {
        planDirty = true;
      }
    });

    document.addEventListener('input', function (e) {
      if (e.target.closest('#tab-plans') && e.target.id !== 'planCo') planDirty = true;
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      var id = b.getAttribute('data-id');
      if (a === 'eC') openCompanyForm(id);
      else if (a === 'dC') deleteCompany(id);
      else if (a === 'profileC') openProfile(id);
      else if (a === 'planC') openPlanFor(id);
      else if (a === 'eP') editPost(id);
      else if (a === 'dP') {
        var p = byId(db.posts, id);
        if (p && confirm('تمسح المنشور ده؟ مفيش رجوع.')) {
          db.posts = db.posts.filter(function (x) { return x.id !== id; });
          save(); renderAll();
        }
      } else if (a === 'goFollowups') switchTab('followups');
      else if (a === 'campaignRename') renameCampaign(b.getAttribute('data-name'));
      else if (a === 'campaignDelete') deleteCampaign(b.getAttribute('data-name'));
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-dl]');
      if (!b) return;
      handleDownload(b.getAttribute('data-dl'));
    });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-contact-delete]');
      if (!b) return;
      var c = companyOf(currentProfileId);
      if (!c) return;
      var cid = b.getAttribute('data-contact-delete');
      if (!confirm('تحذف جهة الاتصال دي؟')) return;
      c.contacts = (c.contacts || []).filter(function (p) { return p.id !== cid; });
      C.appendActivity(c, 'حذف جهة اتصال', 'تم حذف جهة اتصال من ملف الشركة.');
      save(); renderProfile(); renderAll();
    });

    /* Profile */
    $('editProfileCompany').addEventListener('click', function () {
      var id = currentProfileId;
      $('profileDlg').close();
      openCompanyForm(id);
    });
    $('addContact').addEventListener('click', addContact);
    $('addActivity').addEventListener('click', addActivity);
    $('saveProfileMeta').addEventListener('click', saveProfileMeta);
    $('closeProfile').addEventListener('click', function () { $('profileDlg').close(); });
    $('openPlanFromProfile').addEventListener('click', function () {
      var id = currentProfileId;
      $('profileDlg').close();
      openPlanFor(id);
    });

    /* Company form */
    $('companyForm').addEventListener('submit', saveCompany);
    $('companyCancel').addEventListener('click', function () { $('companyDlg').close(); });
    $('companyForm').addEventListener('input', updateFitPreview);
    $('companyForm').addEventListener('change', updateFitPreview);

    /* Plans */
    $('planCo').addEventListener('change', function () { loadPlanForCompany(false); });
    $('genPlan').addEventListener('click', generatePlan);
    $('savePlan').addEventListener('click', savePlan);
    $('copyPlan').addEventListener('click', copyPlan);

    /* Campaigns */
    $('campaignForm').addEventListener('submit', addCampaign);
    $('cSource').innerHTML = opts(C.SOURCES, 'أخرى');

    /* Settings */
    ['wService', 'wCommercial', 'wOpportunity', 'wMarket', 'wAccess'].forEach(function (id) {
      $(id).addEventListener('input', updateWeightSum);
    });
    $('saveWeights').addEventListener('click', saveWeights);
    $('resetWeights').addEventListener('click', resetWeights);

    /* Dashboard */
    $('dashPreset').addEventListener('change', renderDashboard);
    $('dashApply').addEventListener('click', renderDashboard);
    $('dashFrom').addEventListener('change', renderDashboard);
    $('dashTo').addEventListener('change', renderDashboard);

    /* Bulk */
    $('bulkField').addEventListener('change', renderBulkValue);
    $('bulkApply').addEventListener('click', applyBulkEdit);
    $('bulkCancel').addEventListener('click', function () { $('bulkDlg').close(); });

    /* Import / export */
    $('upGo').addEventListener('click', analyzeImport);
    $('applyImport').addEventListener('click', applyPendingImport);
    $('cancelImport').addEventListener('click', cancelPendingImport);
    $('upT').addEventListener('change', function () {
      pendingImport = null;
      $('importPreview').innerHTML = '';
      $('applyImport').disabled = true;
      $('upMsg').textContent = '';
    });

    /* Backup */
    $('bRestore').addEventListener('click', function () { $('fRestore').click(); });
    $('fRestore').addEventListener('change', function () {
      var f = this.files[0];
      if (f) restoreBackup(f);
      this.value = '';
    });

    /* Post generic dialog */
    $('frm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (formCallback) formCallback();
      $('dlg').close();
    });
    $('dX').addEventListener('click', function () { $('dlg').close(); });

    $('pq').addEventListener('input', renderPosts);
    $('pf').addEventListener('change', renderPosts);
    $('addP').addEventListener('click', function () { editPost(null); });

    window.addEventListener('beforeunload', function (e) {
      if (planDirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  function init() {
    $('fst').innerHTML = '<option value="">كل المراحل</option>' + opts(C.STAGE_KEYS, '');
    $('fcls').innerHTML = '<option value="">كل التصنيفات</option>' + opts(C.CLASSIFICATIONS, '');
    $('fsector').innerHTML = '<option value="">كل القطاعات</option>' + opts(C.SECTORS.concat(['غير محدد']), '');
    $('fcountry').innerHTML = '<option value="">كل الدول</option>' + opts(C.COUNTRIES.concat(['غير محدد']), '');
    $('fsort').innerHTML = '<option value="fit">الأعلى Fit Score</option><option value="priority">الأولوية</option>' +
      '<option value="followup">أقرب متابعة</option><option value="value">أعلى قيمة</option>' +
      '<option value="created">الأحدث إضافة</option><option value="name">الاسم</option>';
    $('needs').innerHTML = NEEDS.map(function (n) {
      return '<label><input type="checkbox" value="' + esc(n) + '">' + esc(n) + '</label>';
    }).join('');
    hydrateSettings();
    wireEvents();
    renderAll();
    refreshCampaignOptions();
    initFirebase();
  }

  /* Exposed only for automated tests and debugging. */
  window.__DR_APP = {
    getDb: function () { return db; },
    setDb: function (next) { db = C.normalizeDb(next); renderAll(); },
    renderAll: renderAll,
    switchTab: switchTab,
    openCompanyForm: openCompanyForm,
    openProfile: openProfile,
    openPlanFor: openPlanFor,
    generatePlan: generatePlan,
    savePlan: savePlan,
    applyPendingImport: applyPendingImport,
    fitFor: fitFor,
    today: today
  };

  init();
})();
