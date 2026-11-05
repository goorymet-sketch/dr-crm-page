/*!
 * Digital Reach CRM — Core logic
 * Pure, DOM-free functions shared by the UI and the automated tests.
 * Kept ES5-compatible so the single-page app keeps working on older browsers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRMCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  var STAGES = [
    { key: 'جديد', probability: 10, open: true },
    { key: 'تم التواصل', probability: 20, open: true },
    { key: 'لا يوجد رد', probability: 10, open: true },
    { key: 'رد العميل', probability: 30, open: true },
    { key: 'مهتم', probability: 45, open: true },
    { key: 'محوّل للإدارة', probability: 40, open: true },
    { key: 'تم تحديد اجتماع', probability: 60, open: true },
    { key: 'عرض سعر', probability: 70, open: true },
    { key: 'تفاوض', probability: 85, open: true },
    { key: 'تم الإغلاق', probability: 100, open: false },
    { key: 'خسرنا', probability: 0, open: false },
    { key: 'غير مناسب', probability: 0, open: false }
  ];
  var STAGE_KEYS = STAGES.map(function (s) { return s.key; });
  var STAGE_MAP = {};
  STAGES.forEach(function (s) { STAGE_MAP[s.key] = s; });

  var REPLY_STATUSES = ['لم يتم التواصل', 'لا يوجد رد', 'رد العميل', 'مهتم', 'محوّل للإدارة', 'غير مناسب'];
  var SOURCES = ['جوجل ماب', 'انستجرام', 'فيسبوك', 'واتساب', 'ترشيح', 'أخرى'];
  var SECTORS = ['السياحة والسفر', 'العقارات والوسطاء العقاريون', 'وكالات التسويق', 'تجارة إلكترونية', 'خدمات احترافية', 'أخرى'];
  var OPPORTUNITY_TYPES = ['عميل محتمل', 'شريك محتمل'];
  var PRIORITIES = ['عالية', 'متوسطة', 'منخفضة'];
  var CONFIDENCE_LEVELS = ['غير محدد', 'مرتفع', 'متوسط', 'منخفض'];
  var COUNTRIES = ['السعودية', 'الإمارات', 'قطر', 'الكويت', 'البحرين', 'عمان', 'السوق الخليجي', 'أخرى'];
  var CURRENCIES = ['SAR', 'AED', 'QAR', 'KWD', 'BHD', 'OMR', 'USD', 'أخرى'];
  var CLASSIFICATIONS = ['HOT', 'WARM', 'COLD'];

  var DEFAULT_FIT_WEIGHTS = {
    service: 30,
    commercial: 20,
    opportunity: 20,
    market: 15,
    access: 15
  };

  var FIT_COMPONENTS = [
    { key: 'service', label: 'ملاءمة الخدمة لنشاط الشركة', weight: 30 },
    { key: 'commercial', label: 'الإمكانية التجارية وحجم الفرصة', weight: 20 },
    { key: 'opportunity', label: 'وجود فرصة أو مشكلة ملحوظة', weight: 20 },
    { key: 'market', label: 'ملاءمة السوق المستهدف', weight: 15 },
    { key: 'access', label: 'سهولة الوصول إلى صاحب القرار', weight: 15 }
  ];

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function asNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function hasText(v) { return v != null && String(v).trim() !== ''; }
  function text(v) { return v == null ? '' : String(v); }
  function uid() { return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function parseEmployees(value) {
    var s = text(value);
    if (!s.trim()) return null;
    var nums = (s.match(/\d[\d,\.]*/g) || []).map(function (x) { return asNum(x.replace(/,/g, '')); }).filter(function (n) { return n >= 0; });
    if (!nums.length) return null;
    if (nums.length === 1) return nums[0];
    return Math.round((nums[0] + nums[1]) / 2);
  }

  function digits(value) { return text(value).replace(/\D/g, ''); }

  function normPhone(value, country) {
    var d = digits(value);
    d = d.replace(/^00/, '');
    if (!d) return '';
    var c = normHeader(country || '');
    var callingCodes = [
      { code: '966', match: /سعود|saudi|ksa/ },
      { code: '971', match: /امارات|uae|emirat|دبي|ابوظبي|ابو ظبي/ },
      { code: '974', match: /قطر|qatar/ },
      { code: '965', match: /كويت|kuwait/ },
      { code: '973', match: /بحرين|bahrain/ },
      { code: '968', match: /عمان|oman/ }
    ];
    var codeMatch = callingCodes.filter(function (x) { return x.match.test(c); })[0];
    var alreadyInternational = callingCodes.some(function (x) { return d.indexOf(x.code) === 0; });
    if (!alreadyInternational && codeMatch) {
      if (d.charAt(0) === '0') d = codeMatch.code + d.slice(1);
      else if (d.length === 9 && d.charAt(0) === '5') d = codeMatch.code + d;
    }
    return d;
  }

  function normHeader(value) {
    return text(value)
      .trim()
      .toLowerCase()
      .replace(/[\u064B-\u0652\u0640]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[_\-\/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normName(value) {
    return normHeader(value).replace(/[^a-z0-9\u0600-\u06FF]/g, '');
  }

  function formatMoney(value, currency) {
    var n = asNum(value);
    var cur = hasText(currency) ? String(currency) : '';
    var body = Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return cur ? cur + ' ' + body : body;
  }

  function moneyByCurrency(map) {
    return Object.keys(map).sort().map(function (cur) {
      return { currency: cur, value: map[cur], label: formatMoney(map[cur], cur === 'غير محدد' ? '' : cur) };
    });
  }

  /* ------------------------------------------------------------------ *
   * Stage / pipeline helpers
   * ------------------------------------------------------------------ */

  function stageMeta(stage) {
    return STAGE_MAP[stage] || { key: stage || 'جديد', probability: 10, open: true };
  }
  function isStage(stage) { return !!STAGE_MAP[stage]; }
  function isOpenStage(stage) { return stageMeta(stage).open; }
  function isClosedStage(stage) { return !stageMeta(stage).open; }
  function isLostStage(stage) { return stage === 'خسرنا' || stage === 'غير مناسب'; }
  function stageProbability(stage) { return stageMeta(stage).probability; }

  function dealProgress(stage) {
    var map = {
      'جديد': 5, 'تم التواصل': 20, 'لا يوجد رد': 15, 'رد العميل': 35, 'مهتم': 50,
      'محوّل للإدارة': 55, 'تم تحديد اجتماع': 70, 'عرض سعر': 80, 'تفاوض': 90,
      'تم الإغلاق': 100, 'خسرنا': 0, 'غير مناسب': 0
    };
    return map[stage] != null ? map[stage] : 5;
  }

  function dealProbability(company) {
    var p = company.probability;
    if (p !== '' && p != null && isNum(Number(p))) return clamp(Number(p), 0, 100);
    return stageProbability(company.stage);
  }

  function hasContactActivity(company) {
    var acts = Array.isArray(company.activities) ? company.activities : [];
    var contactTypes = ['مكالمة', 'واتساب', 'بريد إلكتروني', 'اجتماع', 'رد العميل'];
    for (var i = 0; i < acts.length; i++) {
      if (contactTypes.indexOf(acts[i] && acts[i].type) > -1) return true;
    }
    return false;
  }

  /* Funnel rank: 1 contacted, 2 interested, 3 meeting, 4 quote, 5 won. */
  function funnelRank(stage) {
    var map = {
      'جديد': 0,
      'تم التواصل': 1,
      'لا يوجد رد': 1,
      'رد العميل': 1,
      'مهتم': 2,
      'محوّل للإدارة': 2,
      'تم تحديد اجتماع': 3,
      'عرض سعر': 4,
      'تفاوض': 4,
      'تم الإغلاق': 5,
      'خسرنا': null,
      'غير مناسب': null
    };
    return map[stage] === undefined ? 0 : map[stage];
  }

  /**
   * Best-known funnel position for a company.
   * Lost companies without stage history are deliberately reported as unknown
   * so their unknown position never distorts conversion rates.
   */
  function reachedStages(company) {
    var hist = Array.isArray(company.stageHistory) ? company.stageHistory : [];
    var rank = -1;
    var known = hist.length > 0;
    if (hist.length) {
      hist.forEach(function (h) {
        var r1 = funnelRank(h && h.toStage);
        var r2 = funnelRank(h && h.fromStage);
        if (r1 != null && r1 > rank) rank = r1;
        if (r2 != null && r2 > rank) rank = r2;
      });
    }
    if (!isLostStage(company.stage)) {
      var r = funnelRank(company.stage);
      if (r != null && r > rank) rank = r;
      if (r != null) known = true;
    }
    if (!known && hasContactActivity(company)) {
      /* We know they were contacted, but not how far they went. */
      return { known: false, contacted: true, interested: false, quote: false, won: false, rank: 1 };
    }
    if (!known) return { known: false, contacted: false, interested: false, quote: false, won: false, rank: 0 };
    if (hasContactActivity(company) || (hasText(company.replyStatus) && company.replyStatus !== 'لم يتم التواصل')) {
      if (rank < 1) rank = 1;
    }
    return {
      known: true,
      contacted: rank >= 1,
      interested: rank >= 2,
      quote: rank >= 4,
      won: company.stage === 'تم الإغلاق' || rank >= 5,
      rank: Math.max(rank, 0)
    };
  }

  function appendActivity(company, type, note, at) {
    if (!company) return;
    if (!Array.isArray(company.activities)) company.activities = [];
    var iso = at || new Date().toISOString();
    company.activities.push({
      id: uid(),
      type: type || 'ملاحظة داخلية',
      note: text(note),
      date: new Date(iso).toLocaleString('ar-EG'),
      at: iso
    });
    company.lastActivityAt = iso;
    var contactTypes = ['مكالمة', 'واتساب', 'بريد إلكتروني', 'اجتماع', 'رد العميل'];
    if (contactTypes.indexOf(type) > -1) company.lastContactAt = iso;
  }

  function recordStageChange(company, newStage, at) {
    if (!company || !isStage(newStage) || company.stage === newStage) return false;
    var old = company.stage || 'جديد';
    if (!Array.isArray(company.stageHistory)) company.stageHistory = [];
    company.stageHistory.push({ fromStage: old, toStage: newStage, at: at || new Date().toISOString() });
    company.stage = newStage;
    if (!company.probabilityManual) company.probability = stageProbability(newStage);
    if (newStage === 'تم الإغلاق') company.closedAt = at || new Date().toISOString();
    if (newStage === 'خسرنا' || newStage === 'غير مناسب') company.closedAt = at || new Date().toISOString();
    appendActivity(company, 'تغيير المرحلة', 'تم تغيير المرحلة من ' + old + ' إلى ' + newStage, at);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Fit score
   * ------------------------------------------------------------------ */

  function classify(score) {
    var n = Number(score);
    if (!isFinite(n)) return '';
    if (n >= 80) return 'HOT';
    if (n >= 60) return 'WARM';
    return 'COLD';
  }

  function classificationLabel(c) {
    return c === 'HOT' ? 'HOT — أولوية عالية' : c === 'WARM' ? 'WARM — أولوية متوسطة' : c === 'COLD' ? 'COLD — أولوية منخفضة' : 'غير مصنّف';
  }

  function classificationColor(c) {
    return c === 'HOT' ? '#ff6b6b' : c === 'WARM' ? '#ffc400' : c === 'COLD' ? '#58bec6' : '#aab3d1';
  }

  function normalizeWeights(weights) {
    var w = {};
    var total = 0;
    FIT_COMPONENTS.forEach(function (c) {
      var raw = weights && weights[c.key];
      var n = isNum(Number(raw)) && Number(raw) >= 0 ? Number(raw) : DEFAULT_FIT_WEIGHTS[c.key];
      w[c.key] = n;
      total += n;
    });
    if (total <= 0) {
      w = JSON.parse(JSON.stringify(DEFAULT_FIT_WEIGHTS));
      total = 100;
    }
    return { weights: w, total: total };
  }

  function emptyBreakdown() {
    return { service: null, commercial: null, opportunity: null, market: null, access: null };
  }

  function autoComponent(key, company) {
    var sector = company.sector || '';
    if (key === 'service') {
      var base = { 'السياحة والسفر': 70, 'العقارات والوسطاء العقاريون': 75, 'وكالات التسويق': 65 }[sector];
      if (base == null) {
        var ind = normHeader(company.industry);
        if (/سياح|سفر|حجز|طيران|عمر/.test(ind)) base = 70;
        else if (/عقار|وسيط|تطوير عقاري/.test(ind)) base = 75;
        else if (/تسويق|اعلان|دعاي/.test(ind)) base = 65;
        else if (ind) base = 35;
      }
      return { value: base == null ? 0 : base, available: base != null, note: base == null ? 'القطاع غير محدد' : 'تقدير تلقائي من القطاع — راجعه يدويًا' };
    }
    if (key === 'commercial') {
      var emp = parseEmployees(company.employees);
      var rev = hasText(company.annualRevenueEstimate);
      if (emp == null && !rev) return { value: 0, available: false, note: 'لا يوجد تقدير لعدد الموظفين أو المبيعات' };
      var v = 0;
      if (emp != null) v = emp < 10 ? 30 : emp < 50 ? 50 : emp < 200 ? 65 : 80;
      else v = 40;
      if (rev) v = clamp(v + 10, 0, 100);
      return { value: v, available: true, note: 'تقدير تقريبي من الحجم المعلن — ليس تقييمًا ماليًا مؤكدًا' };
    }
    if (key === 'opportunity') {
      return { value: 0, available: false, note: 'لا يُحتسب تلقائيًا — يحتاج تقييمًا يدويًا للفرصة أو المشكلة' };
    }
    if (key === 'market') {
      var country = normHeader(company.country || company.targetMarket);
      if (!country) return { value: 0, available: false, note: 'الدولة/السوق غير محدد' };
      if (/سعود|saudi|ksa|امارات|uae|دبي|ابو ظبي|ابوظبي/.test(country)) return { value: 90, available: true, note: 'السوق الأساسي المستهدف' };
      if (/قطر|qatar|كويت|kuwait|بحرين|bahrain|عمان|oman|خليج|gcc/.test(country)) return { value: 75, available: true, note: 'سوق خليجي ضمن النطاق' };
      return { value: 40, available: true, note: 'خارج الأسواق المستهدفة الأساسية' };
    }
    if (key === 'access') {
      var v2 = 0;
      if (hasText(company.contact)) v2 += 40;
      if (hasText(company.phone) || hasText(company.whatsapp)) v2 += 30;
      if (hasText(company.linkedin)) v2 += 30;
      return { value: clamp(v2, 0, 100), available: v2 > 0, note: v2 > 0 ? 'محسوبة من بيانات التواصل المتاحة فقط' : 'لا توجد بيانات تواصل' };
    }
    return { value: 0, available: false, note: '' };
  }

  /**
   * computeFit returns the weighted score, per-component values and confidence.
   * Missing components count as zero so the result stays conservative; the
   * result is flagged preliminary until an analyst fills them in.
   */
  function computeFit(company, weights) {
    company = company || {};
    var nw = normalizeWeights(weights);
    var bd = company.fitBreakdown && typeof company.fitBreakdown === 'object' ? company.fitBreakdown : {};
    var hasNativeBreakdown = FIT_COMPONENTS.some(function (c) { return bd[c.key] != null && bd[c.key] !== '' && isNum(Number(bd[c.key])); });
    var nativeMode = company.fitMode === 'components' || hasNativeBreakdown;
    var legacy = !nativeMode && company.fitScore !== '' && company.fitScore != null && isNum(Number(company.fitScore));
    if (legacy) {
      var ls = clamp(Number(company.fitScore), 0, 100);
      var lc = hasText(company.fitConfidence) && company.fitConfidence !== 'غير محدد' ? company.fitConfidence : 'غير محدد';
      return {
        mode: 'legacy',
        score: Math.round(ls),
        classification: (company.classificationOverride && CLASSIFICATIONS.indexOf(company.classificationOverride) > -1) ? company.classificationOverride : classify(ls),
        computedClassification: classify(ls),
        confidence: lc,
        preliminary: true,
        manualCount: 0,
        missing: [],
        components: [],
        override: !!(company.classificationOverride && CLASSIFICATIONS.indexOf(company.classificationOverride) > -1),
        notes: ['هذه الدرجة محفوظة من النسخة السابقة. أعد التقييم بالمعايير الجديدة لمعرفة مصدرها.']
      };
    }

    var total = 0;
    var manualCount = 0;
    var availableCount = 0;
    var missing = [];
    var components = FIT_COMPONENTS.map(function (c) {
      var manual = bd[c.key];
      var auto = autoComponent(c.key, company);
      var manualNum = manual !== '' && manual != null && isNum(Number(manual)) ? clamp(Number(manual), 0, 100) : null;
      var value = manualNum != null ? manualNum : auto.value;
      var source = manualNum != null ? 'manual' : (auto.available ? 'auto' : 'missing');
      if (manualNum != null) manualCount++;
      if (source !== 'missing') availableCount++;
      else missing.push(c.label);
      var weight = nw.weights[c.key];
      total += value * weight;
      return {
        key: c.key,
        label: c.label,
        weight: weight,
        value: Math.round(value),
        source: source,
        note: manualNum != null ? 'قيمة يدوية' : auto.note,
        contribution: Math.round(value * weight / nw.total)
      };
    });

    var score = Math.round(total / nw.total);
    var computed = classify(score);
    var override = company.classificationOverride && CLASSIFICATIONS.indexOf(company.classificationOverride) > -1;
    var hasOpportunityText = hasText(company.observedOpportunity) || hasText(company.problem);
    var coreData = hasText(company.sector || company.industry) && hasText(company.country || company.targetMarket) && hasText(company.contact);
    var confidence;
    if (manualCount >= 4 && availableCount === 5 && hasOpportunityText && coreData) confidence = 'مرتفع';
    else if (manualCount >= 2 && availableCount >= 3) confidence = 'متوسط';
    else confidence = 'منخفض';
    if (hasText(company.fitConfidence) && company.fitConfidence !== 'غير محدد') confidence = company.fitConfidence;

    var notes = [];
    if (missing.length) notes.push('حقول ناقصة: ' + missing.join('، ') + '. النتيجة أولية وتحتاج بحثًا إضافيًا.');
    if (manualCount < 3) notes.push('أقل من 3 معايير مقيّمة يدويًا؛ لا تعتبر النتيجة نهائية.');
    if (override) notes.push('التصنيف محدّد يدويًا بشكل صريح.');
    if (!hasOpportunityText) notes.push('لم تُسجل فرصة أو مشكلة ملحوظة؛ لا تمنح الشركة درجة عالية قبل التحقق.');

    return {
      mode: 'components',
      score: score,
      classification: override ? company.classificationOverride : computed,
      computedClassification: computed,
      confidence: confidence,
      preliminary: missing.length > 0 || manualCount < 3,
      manualCount: manualCount,
      availableCount: availableCount,
      missing: missing,
      components: components,
      weights: nw.weights,
      weightTotal: nw.total,
      override: !!override,
      notes: notes
    };
  }

  /* ------------------------------------------------------------------ *
   * Normalisation / migration (additive only — never deletes fields)
   * ------------------------------------------------------------------ */

  function oneOf(value, list, fallback) {
    return list.indexOf(value) > -1 ? value : fallback;
  }

  function normalizeSources(value) {
    if (Array.isArray(value)) {
      return value.map(function (s) {
        if (typeof s === 'string') return { label: s, url: '' };
        return { label: text(s && s.label), url: text(s && s.url) };
      }).filter(function (s) { return hasText(s.label) || hasText(s.url); });
    }
    if (hasText(value)) return [{ label: text(value), url: '' }];
    return [];
  }

  function normalizeCompany(raw) {
    var c = raw && typeof raw === 'object' ? raw : {};
    if (!hasText(c.id)) c.id = uid();
    c.name = text(c.name);
    c.stage = hasText(c.stage) ? text(c.stage) : 'جديد';
    c.replyStatus = hasText(c.replyStatus) ? text(c.replyStatus) : 'لم يتم التواصل';
    c.source = hasText(c.source) ? text(c.source) : 'أخرى';
    c.opportunityType = hasText(c.opportunityType) ? text(c.opportunityType) : inferOpportunityType(c);
    c.priority = hasText(c.priority) ? text(c.priority) : 'متوسطة';
    c.revenueConfidence = hasText(c.revenueConfidence) ? text(c.revenueConfidence) : 'غير محدد';
    c.fitConfidence = hasText(c.fitConfidence) ? text(c.fitConfidence) : 'غير محدد';
    c.classificationOverride = oneOf(c.classificationOverride, CLASSIFICATIONS.concat(['']), '');
    c.sector = hasText(c.sector) ? c.sector : inferSector(c.industry);
    if (!Array.isArray(c.contacts)) c.contacts = [];
    if (!Array.isArray(c.activities)) c.activities = [];
    if (!Array.isArray(c.stageHistory)) c.stageHistory = [];
    if (!c.fitBreakdown || typeof c.fitBreakdown !== 'object') c.fitBreakdown = emptyBreakdown();
    c.researchSources = normalizeSources(c.researchSources && c.researchSources.length ? c.researchSources : c.researchSource);
    if (c.researchSource == null) c.researchSource = c.researchSources.map(function (s) { return s.label; }).filter(Boolean).join(' | ');
    if (c.probability == null || c.probability === '') c.probability = stageProbability(c.stage);
    c.probabilityManual = !!c.probabilityManual;
    c.currency = hasText(c.currency) ? c.currency : '';
    return c;
  }

  function inferSector(industry) {
    var s = normHeader(industry);
    if (!s) return '';
    if (/سياح|سفر|حجز|طيران|عمر/.test(s)) return 'السياحة والسفر';
    if (/عقار|وسيط عقاري|تطوير عقاري|املاك/.test(s)) return 'العقارات والوسطاء العقاريون';
    if (/تسويق|اعلان|دعاي|media|marketing/.test(s)) return 'وكالات التسويق';
    if (/تجاره|متجر|ecommerce|shop|بيع Online/.test(s)) return 'تجارة إلكترونية';
    if (/استشار|محاسب|قانون|خدمات/.test(s)) return 'خدمات احترافية';
    return 'أخرى';
  }

  function inferOpportunityType(company) {
    return (company.sector === 'وكالات التسويق' || inferSector(company.industry) === 'وكالات التسويق') ? 'شريك محتمل' : 'عميل محتمل';
  }

  function normalizeCampaign(raw) {
    var c = raw && typeof raw === 'object' ? raw : {};
    if (!hasText(c.id)) c.id = uid();
    c.name = text(c.name);
    c.source = oneOf(c.source, SOURCES, 'أخرى');
    c.notes = text(c.notes);
    c.active = c.active !== false;
    c.created = hasText(c.created) ? c.created : todayISO();
    return c;
  }

  function normalizeDb(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var db = {
      companies: Array.isArray(r.companies) ? r.companies.map(normalizeCompany) : [],
      posts: Array.isArray(r.posts) ? r.posts : [],
      plans: r.plans && typeof r.plans === 'object' && !Array.isArray(r.plans) ? r.plans : {},
      campaigns: Array.isArray(r.campaigns) ? r.campaigns.map(normalizeCampaign).filter(function (c) { return hasText(c.name); }) : [],
      settings: {
        fitWeights: normalizeWeights(r.settings && r.settings.fitWeights).weights,
        updatedAt: (r.settings && r.settings.updatedAt) || ''
      }
    };
    /* Preserve unknown top-level keys so a save never drops data written by
       another version of the app. */
    Object.keys(r).forEach(function (k) {
      if (!(k in db)) db[k] = r[k];
    });
    return db;
  }

  function normalizePlan(raw) {
    var p = raw && typeof raw === 'object' ? raw : {};
    var out = {
      version: 2,
      companySummary: text(p.companySummary),
      whySelected: text(p.whySelected),
      service: text(p.service),
      angle: text(p.angle),
      firstContactGoal: text(p.firstContactGoal),
      openingMessage: text(p.openingMessage),
      discoveryQuestions: Array.isArray(p.discoveryQuestions) ? p.discoveryQuestions.slice() : (hasText(p.discoveryQuestions) ? String(p.discoveryQuestions).split(/\r?\n/).filter(Boolean) : []),
      presentation: text(p.presentation),
      objections: Array.isArray(p.objections) ? p.objections.map(function (o) {
        return typeof o === 'string' ? { objection: o, response: '' } : { objection: text(o && o.objection), response: text(o && o.response) };
      }) : [],
      cta: text(p.cta),
      followUp: Array.isArray(p.followUp) ? p.followUp.map(function (f) {
        return { day: isNum(Number(f && f.day)) ? Number(f.day) : asNum(f && f.day), action: text(f && f.action) };
      }) : [],
      needs: Array.isArray(p.needs) ? p.needs.slice() : [],
      text: text(p.text),
      updated: text(p.updated),
      generatedAt: text(p.generatedAt)
    };
    if (!out.objections.length && hasText(p.objections)) out.objections = [];
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Sector playbooks + independent sales plans
   * ------------------------------------------------------------------ */

  var FOLLOWUP_DAYS = [
    { day: 0, action: 'أول رسالة أو مكالمة — الهدف: تأكيد المسؤول المناسب وفتح الحوار.' },
    { day: 2, action: 'متابعة أولى — تذكير مختصر بسؤال واحد مرتبط بالاحتياج.' },
    { day: 5, action: 'متابعة مع توضيح قيمة الخدمة — نقطة عملية واحدة فقط بدون وعود بأرقام.' },
    { day: 8, action: 'محاولة الوصول لصاحب القرار عبر قناة مختلفة.' },
    { day: 14, action: 'إغلاق المتابعة أو تحديد موعد إعادة التواصل — بدون إلحاح.' }
  ];

  var SECTOR_MODELS = {
    'السياحة والسفر': {
      defaultType: 'عميل محتمل',
      services: ['تنظيم متابعة استفسارات الحجوزات', 'تأهيل العملاء قبل التسعير', 'متابعة الحجوزات غير المكتملة'],
      angle: 'تحويل الاستفسارات المتناثرة إلى مسار متابعة واضح حتى الحجز',
      problems: ['استفسارات كثيرة بلا متابعة موحّدة', 'تسرّب الحجوزات غير المكتملة', 'ضعف قياس مصادر الحجوزات'],
      questions: [
        'كم استفسار حجز يوصلكم أسبوعيًا تقريبًا؟',
        'مين المسؤول عن متابعة الاستفسارات حاليًا؟',
        'كيف تسجلون حالة كل استفسار حتى الحجز؟',
        'ما أكثر سبب يجعل العميل لا يكمل الحجز؟',
        'هل تقيسون مصدر كل استفسار وكل حجز؟'
      ],
      presentation: 'عرض قصير لمسار المتابعة خطوة بخطوة على أمثلة من قطاع السفر، مع مثال توضيحي — بدون وعود بأرقام أو نسب غير موثقة.',
      objections: [
        { objection: 'عندنا فريق حجوزات', response: 'الهدف دعم الفريق بمسار متابعة يمنع ضياع الاستفسارات، وليس استبداله.' },
        { objection: 'ما عندنا وقت', response: 'نبدأ بخطوة صغيرة: تنظيم الاستفسارات الحالية وقياس نسبة الإكمال قبل أي توسّع.' },
        { objection: 'السعر مرتفع', response: 'نربط النطاق بالمرحلة الحالية ونقسمه على مراحل قابلة للإيقاف.' }
      ],
      cta: 'موعد 20 دقيقة لمراجعة مسار متابعة الاستفسارات الحالي وتحديد نقطة التحسين الأولى.'
    },
    'العقارات والوسطاء العقاريون': {
      defaultType: 'عميل محتمل',
      services: ['تأهيل المشترين والمستأجرين قبل المعاينة', 'تنظيم المعاينات ومتابعتها', 'إدارة مراحل الإغلاق'],
      angle: 'تأهيل العميل قبل المعاينة وتقليل الوقت المهدور على عملاء غير جاهزين',
      problems: ['معاينات كثيرة بدون تأهيل مسبق', 'متابعة ضعيفة بعد المعاينة', 'عدم وضوح مرحلة كل عميل'],
      questions: [
        'كم استفسار عقاري يوصلكم أسبوعيًا؟',
        'كيف تفرزون الجاد من غير الجاد قبل المعاينة؟',
        'كيف تتابعون العميل بعد المعاينة؟',
        'مين المسؤول عن متابعة كل عميل؟',
        'هل لديكم تقرير واضح لكل مرحلة حتى الإغلاق؟'
      ],
      presentation: 'خريطة لمسار العميل من الاستفسار إلى الإغلاق مع نقاط القياس، وتجربة عملية على بيانات تجريبية — بدون وعود بنتائج.',
      objections: [
        { objection: 'الوسطاء يعرفون السوق', response: 'الخبرة السوقية أساس، والتنظيم يمنع ضياع الفرص بين الاستفسار والإغلاق.' },
        { objection: 'العملاء يتواصلون على واتساب مباشرة', response: 'نحافظ على نفس القناة ونضيف تسجيلًا ومتابعة واضحة لكل محادثة.' },
        { objection: 'جربنا أنظمة قبل', response: 'نبدأ بنطاق محدود وخطوات قابلة للقياس قبل التوسّع.' }
      ],
      cta: 'مكالمة 20 دقيقة لمراجعة مسار التأهيل والمتابعة الحالي وتحديد أول نقطة تحسين.'
    },
    'وكالات التسويق': {
      defaultType: 'شريك محتمل',
      services: ['Sales Development بنظام White-label', 'تشغيل تأهيل العملاء لعملاء الوكالة', 'بناء تقارير مبيعات موحّدة لعملائها'],
      angle: 'شراكة تكمّل خدمات التسويق الحالية بطبقة Sales Development قابلة للتشغيل باسم الوكالة',
      problems: ['الوكالة تولّد Leads لكن العميل يفتقد متابعة منظمة', 'عدم وجود تقارير مبيعات موحّدة لعملاء الوكالة'],
      questions: [
        'كم عميل حالي يحتاج دعمًا في متابعة العملاء المحتملين؟',
        'هل تقدمون حاليًا أي خدمة Sales Development؟',
        'كيف تُسلّمون نتائج الحملات لعملائكم؟',
        'هل تفضلون White-label أم تعاونًا مباشرًا؟',
        'ما القطاعات الأكثر طلبًا عند عملائكم؟'
      ],
      presentation: 'نموذج شراكة White-label بنطاق واضح وتقارير وحدود مسؤولية — بدون وعود بنتائج.',
      objections: [
        { objection: 'عندنا فريق داخلي', response: 'الشراكة تكمّل الفريق في الطبقة التي لا يغطيها، ويمكن البدء بعميل واحد.' },
        { objection: 'نخاف نفقد علاقة العميل', response: 'الاتفاق يحدد أن العلاقة تبقى باسم الوكالة مع تقارير شفافة.' },
        { objection: 'تجربة سابقة لم تنجح', response: 'نبدأ بمرحلة تجريبية محددة النطاق والمدة مع معايير تقييم واضحة.' }
      ],
      cta: 'مكالمة استكشاف 20 دقيقة لتحديد عميل واحد مناسب لتجربة الشراكة.'
    },
    'تجارة إلكترونية': {
      defaultType: 'عميل محتمل',
      services: ['متابعة السلات المتروكة يدويًا', 'تأهيل استفسارات ما قبل الشراء', 'تنظيم متابعة العملاء المتكررين'],
      angle: 'تحويل الاستفسارات والسلات المتروكة إلى متابعة منظمة بدل فقدانها',
      problems: ['سلات متروكة بدون متابعة', 'استفسارات ما قبل الشراء موزعة على قنوات متعددة'],
      questions: ['كم طلب/استفسار يوصلكم يوميًا؟', 'كيف تتابعون السلات المتروكة حاليًا؟', 'من المسؤول عن الرد على الاستفسارات؟', 'هل تقيسون مصدر كل طلب؟'],
      presentation: 'عرض عملي لمسار متابعة الطلبات والاستفسارات، مع مثال توضيحي — بدون وعود بنسب تحويل.',
      objections: [
        { objection: 'عندنا أتمتة', response: 'الأتمتة تحتاج قواعد متابعة واضحة؛ نراجع القواعد ونكمل الناقص.' },
        { objection: 'الحجم صغير', response: 'نبدأ بخطوة تناسب الحجم الحالي ونتوسّع عند وجود دليل.' }
      ],
      cta: 'مراجعة 20 دقيقة لمسار متابعة الطلبات والاستفسارات.'
    },
    'خدمات احترافية': {
      defaultType: 'عميل محتمل',
      services: ['تنظيم متابعة العملاء المحتملين', 'بناء عملية عرض سعر ومتابعة', 'إعداد تقارير المبيعات'],
      angle: 'تنظيم المتابعة والوصول لصاحب القرار بدل الاعتماد على العلاقات الشخصية',
      problems: ['متابعة غير منتظمة للعملاء المحتملين', 'عدم وضوح مرحلة كل عرض سعر'],
      questions: ['كيف تصلون لعملاء جدد حاليًا؟', 'كم عرض سعر تقدمون شهريًا؟', 'كيف تتابعون العروض غير المغلقة؟', 'ما أكبر سبب لخسارة العميل؟'],
      presentation: 'مراجعة لعملية البيع الحالية وتحديد نقاط القياس، مع نموذج توضيحي — بدون وعود بأرقام.',
      objections: [
        { objection: 'العلاقات تكفي', response: 'العلاقات تفتح الباب، والتنظيم يمنع ضياع الفرص ويحافظ على المتابعة.' },
        { objection: 'العملية معقدة', response: 'نبدأ بخطوتين فقط: تسجيل كل فرصة وموعد متابعة واضح.' }
      ],
      cta: 'جلسة 20 دقيقة لمراجعة عملية المتابعة الحالية.'
    },
    'أخرى': {
      defaultType: 'عميل محتمل',
      services: ['بناء عملية Sales Development منظمة', 'تنظيم متابعة العملاء المحتملين', 'إعداد تقارير المبيعات وقياس التحويل'],
      angle: 'تنظيم عملية البيع والمتابعة بدل الاعتماد على المتابعة اليدوية المتفرقة',
      problems: ['متابعة متفرقة للعملاء المحتملين', 'عدم وضوح مراحل البيع', 'غياب قياس مصادر العملاء'],
      questions: ['كيف تصلون لعملاء جدد حاليًا؟', 'من المسؤول عن متابعة العميل؟', 'كيف تسجلون مرحلة كل عميل؟', 'ما أكبر عائق أمام إغلاق الصفقة؟', 'هل تقيسون مصادر العملاء؟'],
      presentation: 'مراجعة لعملية البيع الحالية مع مثال توضيحي — بدون وعود بنتائج أو أرقام غير موثقة.',
      objections: [
        { objection: 'نعمل بدون نظام', response: 'البداية بخطوة صغيرة: تسجيل الفرص ومواعيد المتابعة فقط.' },
        { objection: 'السعر', response: 'نطاق واضح على مراحل، ويمكن إيقافه بعد كل مرحلة.' }
      ],
      cta: 'مكالمة 20 دقيقة لمراجعة عملية البيع الحالية وتحديد أول تحسين.'
    }
  };

  function sectorModel(sector) {
    return SECTOR_MODELS[sector] || SECTOR_MODELS['أخرى'];
  }

  function openingMessage(company, model, type) {
    var name = hasText(company.contact) ? company.contact : 'حضرتك';
    var sector = hasText(company.sector) ? company.sector : (hasText(company.industry) ? company.industry : 'مجالكم');
    var market = hasText(company.country) ? company.country : (hasText(company.targetMarket) ? company.targetMarket : 'السوق');
    var msg;
    if (type === 'شريك محتمل') {
      msg = 'مساء الخير ' + name + '، أنا من Digital Reach. نعمل على طبقة Sales Development تكمّل خدمات وكالات التسويق في ' + market + '، تحديدًا في تنظيم متابعة العملاء المحتملين وتأهيلهم. ' +
        'هل يناسبك اتصال قصير نستكشف فيه إذا كانت هناك فرصة لشراكة White-label مع ' + (company.name || 'شركتكم') + '؟';
    } else {
      msg = 'مساء الخير ' + name + '، أنا من Digital Reach. نساعد شركات ' + sector + ' في ' + market + ' على ' + model.angle + '. ' +
        (hasText(company.observedOpportunity)
          ? 'ورد في ملاحظاتنا الداخلية أن «' + text(company.observedOpportunity).slice(0, 180) + '» — نود التأكد من ذلك قبل اقتراح أي شيء. '
          : '') +
        'هل يناسبك اتصال قصير (15–20 دقيقة) نراجع فيه الوضع الحالي ونحدد إن كان هناك ما يستحق التجربة؟';
    }
    return msg;
  }

  function generateSalesPlan(company, opts) {
    opts = opts || {};
    company = company || {};
    var model = sectorModel(company.sector);
    var type = company.opportunityType || model.defaultType;
    var needs = Array.isArray(opts.needs) ? opts.needs.slice() : [];
    var fit = opts.fit || computeFit(company, opts.weights);
    var country = hasText(company.country) ? company.country : (hasText(company.targetMarket) ? company.targetMarket : 'سوق غير محدد');
    var sector = hasText(company.sector) ? company.sector : (hasText(company.industry) ? company.industry : 'قطاع غير محدد');
    var summaryParts = [company.name || 'شركة بدون اسم', sector, country];
    if (hasText(company.employees)) summaryParts.push('عدد الموظفين المسجل: ' + company.employees);
    if (hasText(company.annualRevenueEstimate)) summaryParts.push('تقدير المبيعات المسجل: ' + company.annualRevenueEstimate + ' (ليس رقمًا مؤكدًا)');
    if (hasText(company.website)) summaryParts.push('الموقع: ' + company.website);

    var why = [];
    if (hasText(company.observedOpportunity)) why.push('الفرصة الملحوظة المسجلة: ' + company.observedOpportunity);
    if (hasText(company.problem)) why.push('المشكلة المحتملة المسجلة: ' + company.problem);
    if (!hasText(company.observedOpportunity) && !hasText(company.problem)) {
      why.push('لم تُسجل فرصة أو مشكلة محددة بعد؛ اختيار الشركة مبني على ملاءمة القطاع والسوق فقط ويحتاج تحققًا في أول تواصل.');
    }
    why.push('درجة الملاءمة ' + fit.score + '/100 وتصنيف ' + (fit.classification || 'غير مصنّف') + ' — ' + (fit.preliminary ? 'تقييم أولي قابل للتغيير، وليس حقيقة مثبتة.' : 'مبنية على معايير مقيّمة، وتبقى تقديرًا داخليًا.'));

    var service = hasText(opts.service) ? opts.service : model.services[0];
    if (type === 'شريك محتمل' && model.services.indexOf('Sales Development بنظام White-label') > -1) service = 'Sales Development بنظام White-label';

    var questions = model.questions.slice();
    if (!hasText(company.employees)) questions.push('كم عدد فريق المبيعات أو الحجوزات حاليًا؟');
    if (!hasText(company.website) && !hasText(company.phone)) questions.push('ما أفضل قناة للتواصل معكم رسميًا؟');
    if (type === 'شريك محتمل') questions.push('كيف تفضلون تقسيم الأدوار والمسؤوليات في الشراكة؟');

    var firstGoal = type === 'شريك محتمل'
      ? 'التأكد من وجود عميل واحد يمكن تجربة الشراكة عليه، وتحديد المسؤول عن القرار.'
      : 'التأكد من وجود مسؤول واضح وتحديد احتياج مؤكد قبل تقديم أي عرض.';

    var followUp = FOLLOWUP_DAYS.map(function (f) {
      var action = f.action;
      if (f.day === 5 && hasText(company.observedOpportunity)) action += ' اربط النقطة بالفرصة المسجلة: ' + text(company.observedOpportunity).slice(0, 120) + '.';
      return { day: f.day, action: action };
    });

    var plan = {
      version: 2,
      companyId: company.id || '',
      companyName: company.name || '',
      opportunityType: type,
      companySummary: summaryParts.join(' — ') + '.',
      whySelected: why.join(' '),
      service: service,
      angle: hasText(company.salesAngle) ? company.salesAngle : model.angle,
      firstContactGoal: firstGoal,
      openingMessage: openingMessage(company, model, type),
      discoveryQuestions: questions,
      presentation: model.presentation,
      objections: model.objections.map(function (o) { return { objection: o.objection, response: o.response }; }),
      cta: model.cta,
      followUp: followUp,
      needs: needs,
      disclaimer: 'هذه خطة عمل داخلية مبنية على البيانات المسجلة فقط. لا تتضمن وعودًا بنتائج أو حجوزات أو إيرادات، وأي تقدير فيها قابل للمراجعة.',
      generatedAt: new Date().toISOString(),
      updated: todayISO()
    };
    plan.text = planToText(plan);
    return plan;
  }

  function planToText(plan) {
    var p = normalizePlan(plan);
    var lines = [];
    lines.push('خطة مبيعات: ' + (plan.companyName || ''));
    lines.push('نوع الفرصة: ' + (plan.opportunityType || '—'));
    lines.push('تاريخ التحديث: ' + (p.updated || todayISO()));
    lines.push('');
    lines.push('1) ملخص الشركة والفرصة');
    lines.push(p.companySummary || '—');
    lines.push('');
    lines.push('2) سبب اختيار الشركة');
    lines.push(p.whySelected || '—');
    lines.push('');
    lines.push('3) الخدمة الأنسب');
    lines.push(p.service || '—');
    lines.push('');
    lines.push('4) زاوية البيع');
    lines.push(p.angle || '—');
    lines.push('');
    lines.push('5) هدف التواصل الأول');
    lines.push(p.firstContactGoal || '—');
    lines.push('');
    lines.push('6) الرسالة الافتتاحية');
    lines.push(p.openingMessage || '—');
    lines.push('');
    lines.push('7) أسئلة الاكتشاف');
    (p.discoveryQuestions || []).forEach(function (q, i) { lines.push('   ' + (i + 1) + '. ' + q); });
    lines.push('');
    lines.push('8) طريقة تقديم العرض');
    lines.push(p.presentation || '—');
    lines.push('');
    lines.push('9) الاعتراضات المتوقعة');
    (p.objections || []).forEach(function (o) {
      lines.push('   - اعتراض: ' + o.objection);
      lines.push('     رد: ' + (o.response || '—'));
    });
    lines.push('');
    lines.push('10) Call to Action');
    lines.push(p.cta || '—');
    lines.push('');
    lines.push('11) خطة متابعة 14 يومًا');
    (p.followUp || []).forEach(function (f) {
      lines.push('   اليوم ' + f.day + ': ' + f.action);
    });
    if (plan.disclaimer) {
      lines.push('');
      lines.push('ملاحظة: ' + plan.disclaimer);
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * Dashboard metrics
   * ------------------------------------------------------------------ */

  function companyDate(c) {
    var d = hasText(c.createdAt) ? String(c.createdAt).slice(0, 10) : text(c.created).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }

  function inPeriod(c, from, to) {
    if (!from && !to) return true;
    var d = companyDate(c);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  function byCurrencyAdd(map, currency, value) {
    var cur = hasText(currency) ? String(currency) : 'غير محدد';
    var n = asNum(value);
    if (!n) return;
    map[cur] = (map[cur] || 0) + n;
  }

  function conversion(num, den, definition) {
    var available = den > 0;
    return {
      numerator: num,
      denominator: den,
      rate: available ? Math.round(num / den * 1000) / 10 : null,
      available: available,
      smallSample: available && den < 5,
      definition: definition || ''
    };
  }

  function dashboardMetrics(companies, opts) {
    opts = opts || {};
    var weights = opts.weights || DEFAULT_FIT_WEIGHTS;
    var from = opts.from || '';
    var to = opts.to || '';
    var list = (Array.isArray(companies) ? companies : []).filter(function (c) { return inPeriod(c, from, to); });
    var excludedUndated = (Array.isArray(companies) ? companies.length : 0) - list.length;
    var classified = { HOT: 0, WARM: 0, COLD: 0, '': 0 };
    var sectors = {};
    var countries = {};
    var stages = {};
    var funnel = { contacted: 0, interested: 0, quote: 0, won: 0 };
    var unknownFunnel = 0;
    var openDeals = 0;
    var openWithValue = 0;
    var wonDeals = 0;
    var lostDeals = 0;
    var notSuitable = 0;
    var openValue = {};
    var wonValue = {};
    var lostValue = {};
    var weighted = {};

    list.forEach(function (c) {
      var cl = computeFit(c, weights).classification || '';
      classified[cl] = (classified[cl] || 0) + 1;
      var sector = hasText(c.sector) ? c.sector : 'غير محدد';
      sectors[sector] = (sectors[sector] || 0) + 1;
      var country = hasText(c.country) ? c.country : 'غير محدد';
      countries[country] = (countries[country] || 0) + 1;
      stages[c.stage] = (stages[c.stage] || 0) + 1;

      var reach = reachedStages(c);
      if (!reach.known) {
        unknownFunnel++;
      } else {
        if (reach.contacted) funnel.contacted++;
        if (reach.interested) funnel.interested++;
        if (reach.quote) funnel.quote++;
        if (reach.won) funnel.won++;
      }
      if (reach.known && reach.won) wonDeals++;

      if (isOpenStage(c.stage)) {
        openDeals++;
        if (asNum(c.value) > 0) openWithValue++;
        byCurrencyAdd(openValue, c.currency, c.value);
        byCurrencyAdd(weighted, c.currency, asNum(c.value) * dealProbability(c) / 100);
      } else if (c.stage === 'تم الإغلاق') {
        byCurrencyAdd(wonValue, c.currency, c.value);
      } else if (c.stage === 'خسرنا') {
        lostDeals++;
        byCurrencyAdd(lostValue, c.currency, c.value);
      } else if (c.stage === 'غير مناسب') {
        notSuitable++;
      }
    });

    var contactToInterest = conversion(funnel.interested, funnel.contacted, 'عدد الشركات التي وصلت لمرحلة مهتم أو أبعد ÷ عدد الشركات التي تم التواصل معها.');
    var interestToQuote = conversion(funnel.quote, funnel.interested, 'عدد الشركات التي وصلت لعرض سعر أو أبعد ÷ عدد الشركات المهتمة.');
    var quoteToWon = conversion(funnel.won, funnel.quote, 'عدد الصفقات المكتسبة ÷ عدد الشركات التي وصلت لعرض سعر.');
    var wonLostBase = wonDeals + lostDeals;
    var winRate = conversion(wonDeals, wonLostBase, 'عدد الصفقات المكتسبة ÷ (المكتسبة + الخاسرة). الصفقات غير المناسبة مستبعدة.');

    var sectorPerf = Object.keys(sectors).map(function (name) {
      var group = list.filter(function (c) { return (hasText(c.sector) ? c.sector : 'غير محدد') === name; });
      var w = group.filter(function (c) { return c.stage === 'تم الإغلاق'; }).length;
      var l = group.filter(function (c) { return c.stage === 'خسرنا'; }).length;
      return {
        name: name,
        total: group.length,
        won: w,
        lost: l,
        open: group.filter(function (c) { return isOpenStage(c.stage); }).length,
        winRate: conversion(w, w + l)
      };
    }).sort(function (a, b) { return b.total - a.total; });

    var sourceMap = {};
    list.forEach(function (c) {
      var s = hasText(c.source) ? c.source : 'أخرى';
      if (!sourceMap[s]) sourceMap[s] = [];
      sourceMap[s].push(c);
    });
    var sourcePerf = Object.keys(sourceMap).map(function (name) {
      var group = sourceMap[name];
      var w = group.filter(function (c) { return c.stage === 'تم الإغلاق'; }).length;
      var l = group.filter(function (c) { return c.stage === 'خسرنا'; }).length;
      return { name: name, total: group.length, won: w, lost: l, winRate: conversion(w, w + l) };
    }).sort(function (a, b) { return b.total - a.total; });

    return {
      total: list.length,
      excludedUndated: excludedUndated,
      classified: classified,
      sectors: Object.keys(sectors).map(function (n) { return { name: n, count: sectors[n] }; }).sort(function (a, b) { return b.count - a.count; }),
      countries: Object.keys(countries).map(function (n) { return { name: n, count: countries[n] }; }).sort(function (a, b) { return b.count - a.count; }),
      stages: STAGE_KEYS.map(function (n) { return { name: n, count: stages[n] || 0 }; }),
      openDeals: openDeals,
      openWithValue: openWithValue,
      wonDeals: wonDeals,
      lostDeals: lostDeals,
      notSuitable: notSuitable,
      openValue: openValue,
      wonValue: wonValue,
      lostValue: lostValue,
      weighted: weighted,
      openValueList: moneyByCurrency(openValue),
      wonValueList: moneyByCurrency(wonValue),
      lostValueList: moneyByCurrency(lostValue),
      weightedList: moneyByCurrency(weighted),
      funnel: funnel,
      unknownFunnel: unknownFunnel,
      conversions: {
        contactToInterest: contactToInterest,
        interestToQuote: interestToQuote,
        quoteToWon: quoteToWon,
        winRate: winRate
      },
      campaigns: campaignMetrics(list, weights),
      sources: sourcePerf,
      sectorPerformance: sectorPerf
    };
  }

  function campaignMetrics(companies, weights) {
    var groups = {};
    (Array.isArray(companies) ? companies : []).forEach(function (c) {
      var name = text(c.campaign).trim();
      if (!name) return;
      if (!groups[name]) groups[name] = [];
      groups[name].push(c);
    });
    return Object.keys(groups).map(function (name) {
      var list = groups[name];
      var contacted = 0, replied = 0, interested = 0, quotes = 0, won = 0, lost = 0, unknown = 0;
      var openValue = {};
      list.forEach(function (c) {
        var reach = reachedStages(c);
        if (!reach.known) {
          unknown++;
        } else {
          if (reach.contacted) contacted++;
          if (reach.interested) interested++;
          if (reach.quote) quotes++;
          if (reach.won) won++;
        }
        if (c.stage === 'خسرنا') lost++;
        if (isOpenStage(c.stage)) byCurrencyAdd(openValue, c.currency, c.value);
        if (REPLY_STATUSES.indexOf(c.replyStatus) > -1 && c.replyStatus !== 'لم يتم التواصل' && c.replyStatus !== 'لا يوجد رد') replied++;
      });
      return {
        name: name,
        total: list.length,
        contacted: contacted,
        replied: replied,
        interested: interested,
        quotes: quotes,
        won: won,
        lost: lost,
        unknownFunnel: unknown,
        openValue: openValue,
        openValueList: moneyByCurrency(openValue),
        contactedToReplied: conversion(replied, contacted, 'عدد من ردوا ÷ عدد من تم التواصل معهم'),
        contactedToInterested: conversion(interested, contacted, 'عدد المهتمين ÷ عدد من تم التواصل معهم'),
        interestedToQuote: conversion(quotes, interested, 'عدد عروض السعر ÷ عدد المهتمين'),
        quoteToWon: conversion(won, quotes, 'عدد الصفقات المكتسبة ÷ عدد عروض السعر')
      };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function followupBuckets(companies, today) {
    today = today || todayISO();
    var list = Array.isArray(companies) ? companies : [];
    var buckets = {
      overdue: [], dueToday: [], upcoming: [], neverContacted: [],
      repliedNotFollowed: [], forwarded: [], meetings: []
    };
    list.forEach(function (c) {
      if (!isOpenStage(c.stage)) return;
      var d = text(c.followUpDate).slice(0, 10);
      if (d && d < today) buckets.overdue.push(c);
      else if (d && d === today) buckets.dueToday.push(c);
      else if (d && d > today) buckets.upcoming.push(c);

      if (!hasContactActivity(c) && c.stage === 'جديد' && c.replyStatus === 'لم يتم التواصل') buckets.neverContacted.push(c);
      if (c.replyStatus === 'رد العميل' && (!d || d <= today)) buckets.repliedNotFollowed.push(c);
      if (c.replyStatus === 'محوّل للإدارة') buckets.forwarded.push(c);
      var md = text(c.meetingDate).slice(0, 10);
      if (md && md >= today) buckets.meetings.push(c);
      else if (!md && c.stage === 'تم تحديد اجتماع') buckets.meetings.push(c);
    });
    buckets.overdue.sort(function (a, b) { return text(a.followUpDate).localeCompare(text(b.followUpDate)); });
    buckets.dueToday.sort(function (a, b) { return text(a.name).localeCompare(text(b.name)); });
    buckets.upcoming.sort(function (a, b) { return text(a.followUpDate).localeCompare(text(b.followUpDate)); });
    buckets.meetings.sort(function (a, b) { return text(a.meetingDate).localeCompare(text(b.meetingDate)); });
    buckets.neverContacted.sort(function (a, b) { return text(b.created).localeCompare(text(a.created)); });
    buckets.repliedNotFollowed.sort(function (a, b) { return text(a.name).localeCompare(text(b.name)); });
    buckets.forwarded.sort(function (a, b) { return text(a.name).localeCompare(text(b.name)); });
    return buckets;
  }

  /* ------------------------------------------------------------------ *
   * CSV import / export
   * ------------------------------------------------------------------ */

  var CSV_COMPANY_FIELDS = [
    { key: 'name', aliases: ['name', 'title', 'company', 'company name', 'الشركة', 'اسم الشركة', 'الاسم'] },
    { key: 'website', aliases: ['website', 'company website', 'website url', 'الموقع الإلكتروني', 'الموقع', 'الموقع الالكتروني'] },
    { key: 'contact', aliases: ['contact', 'contact person', 'المسؤول', 'اسم المسؤول'] },
    { key: 'contactRole', aliases: ['contact role', 'role', 'المنصب', 'منصب المسؤول'] },
    { key: 'phone', aliases: ['phone', 'phone number', 'mobile', 'telephone', 'الرقم', 'رقم', 'الموبايل', 'الهاتف'] },
    { key: 'whatsapp', aliases: ['whatsapp', 'whats app', 'واتساب', 'رقم واتساب'] },
    { key: 'industry', aliases: ['industry', 'category', 'المجال', 'النشاط'] },
    { key: 'sector', aliases: ['sector', 'vertical', 'القطاع', 'نوع النشاط'] },
    { key: 'country', aliases: ['country', 'market', 'الدولة', 'السوق', 'السوق المستهدف'] },
    { key: 'targetMarket', aliases: ['target market', 'target_market', 'السوق المستهدف', 'نطاق السوق'] },
    { key: 'employees', aliases: ['employees', 'employee_count', 'employee count', 'headcount', 'عدد الموظفين', 'العمالة', 'الموظفين'] },
    { key: 'annualRevenueEstimate', aliases: ['annual_revenue_estimate', 'estimated_revenue', 'annual revenue', 'annual revenue estimate', 'المبيعات السنوية التقديرية', 'المبيعات التقديرية', 'حجم المبيعات التقديري'] },
    { key: 'currency', aliases: ['currency', 'العملة', 'عملة'] },
    { key: 'revenueConfidence', aliases: ['revenue_confidence', 'revenue confidence', 'confidence', 'مستوى الثقة', 'ثقة التقدير'] },
    { key: 'estimateBasis', aliases: ['estimate_basis', 'revenue_basis', 'basis', 'أساس التقدير', 'مصدر التقدير', 'أساس التقدير ومصدره'] },
    { key: 'source', aliases: ['source', 'المصدر'] },
    { key: 'campaign', aliases: ['campaign', 'campaign name', 'campaign_name', 'اسم الحملة', 'الحملة', 'قائمة العملاء'] },
    { key: 'stage', aliases: ['stage', 'status', 'المرحلة', 'الحالة'] },
    { key: 'replyStatus', aliases: ['reply_status', 'reply status', 'حالة الرد'] },
    { key: 'value', aliases: ['value', 'deal value', 'deal_value', 'القيمة', 'قيمة الصفقة'] },
    { key: 'probability', aliases: ['probability', 'احتمالية الإغلاق', 'الاحتمالية'] },
    { key: 'owner', aliases: ['owner', 'assigned to', 'المسؤول عن المتابعة', 'مسؤول المتابعة'] },
    { key: 'followUpDate', aliases: ['follow_up_date', 'follow up date', 'next follow up', 'موعد المتابعة', 'موعد المتابعة القادمة'] },
    { key: 'meetingDate', aliases: ['meeting_date', 'meeting date', 'موعد الاجتماع'] },
    { key: 'lastContactAt', aliases: ['last_contact_at', 'last contact', 'آخر تاريخ تواصل', 'تاريخ آخر تواصل'] },
    { key: 'lostReason', aliases: ['lost_reason', 'lost reason', 'سبب الخسارة', 'سبب خسارة الفرصة'] },
    { key: 'facebook', aliases: ['facebook', 'facebook url', 'فيسبوك', 'رابط فيسبوك'] },
    { key: 'instagram', aliases: ['instagram', 'instagram url', 'انستجرام', 'إنستجرام', 'انستغرام', 'رابط انستجرام', 'رابط انستغرام'] },
    { key: 'linkedin', aliases: ['linkedin', 'linkedin url', 'لينكدان', 'لينكدإن', 'رابط لينكدان', 'رابط لينكدإن'] },
    { key: 'opportunityType', aliases: ['opportunity_type', 'opportunity type', 'نوع الفرصة', 'نوع العلاقة'] },
    { key: 'priority', aliases: ['priority', 'الأولوية', 'الاولوية'] },
    { key: 'fitScore', aliases: ['fit_score', 'fit score', 'درجة الملاءمة', 'درجة ملاءمة الشركة'] },
    { key: 'fitConfidence', aliases: ['fit_confidence', 'fit confidence', 'ثقة تقييم الملاءمة', 'مستوى الثقة في التحليل'] },
    { key: 'classificationOverride', aliases: ['classification', 'classification_override', 'التصنيف', 'التصنيف اليدوي'] },
    { key: 'fitService', aliases: ['fit_service', 'service fit', 'ملاءمة الخدمة'] },
    { key: 'fitCommercial', aliases: ['fit_commercial', 'commercial fit', 'الإمكانية التجارية'] },
    { key: 'fitOpportunity', aliases: ['fit_opportunity', 'opportunity score', 'درجة الفرصة'] },
    { key: 'fitMarket', aliases: ['fit_market', 'market fit', 'ملاءمة السوق'] },
    { key: 'fitAccess', aliases: ['fit_access', 'access score', 'سهولة الوصول'] },
    { key: 'observedOpportunity', aliases: ['observed_opportunity', 'opportunity', 'الفرصة الملحوظة', 'الفرصة البيعية الملحوظة', 'فرصة البيع'] },
    { key: 'problem', aliases: ['problem', 'pain point', 'المشكلة المحتملة', 'المشكلة'] },
    { key: 'salesAngle', aliases: ['sales_angle', 'sales angle', 'زاوية البيع', 'زاوية البيع المقترحة'] },
    { key: 'researchSummary', aliases: ['research_summary', 'research summary', 'ملخص البحث', 'ملخص التحليل', 'ملخص البحث والتحليل'] },
    { key: 'researchSource', aliases: ['research_source', 'research source', 'مصدر البحث', 'مصادر البحث', 'مصدر البحث ورابطه'] },
    { key: 'researchUpdatedAt', aliases: ['research_updated_at', 'last research date', 'آخر تحديث للتحليل', 'تاريخ تحديث التحليل'] },
    { key: 'notes', aliases: ['notes', 'note', 'ملاحظات', 'address', 'العنوان'] }
  ];

  var CSV_POST_FIELDS = [
    { key: 'platform', aliases: ['platform', 'المنصة'] },
    { key: 'page', aliases: ['page', 'company', 'الصفحة', 'الشركة'] },
    { key: 'title', aliases: ['title', 'post', 'caption', 'اسم المنشور', 'المنشور'] },
    { key: 'likes', aliases: ['likes', 'الايكات', 'لايكات', 'الإعجابات'] },
    { key: 'commentsCount', aliases: ['comments_count', 'comments count', 'عدد الكومنتات', 'عدد التعليقات'] },
    { key: 'comments', aliases: ['comments', 'الكومنتات', 'التعليقات'] },
    { key: 'link', aliases: ['link', 'url', 'الرابط'] },
    { key: 'date', aliases: ['date', 'التاريخ'] }
  ];

  function parseCSV(input) {
    var t = String(input == null ? '' : input).replace(/^\uFEFF/, '');
    var first = (t.split(/\r?\n/)[0] || '');
    var delim = ',';
    var commas = (first.match(/,/g) || []).length;
    var semis = (first.match(/;/g) || []).length;
    var tabs = (first.match(/\t/g) || []).length;
    if (semis > commas && semis >= tabs) delim = ';';
    else if (tabs > commas) delim = '\t';
    var rows = [];
    var row = [];
    var field = '';
    var quoted = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (quoted) {
        if (ch === '"') {
          if (t[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(function (x) { return String(x).trim(); })) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(function (x) { return String(x).trim(); })) rows.push(row);
    return rows;
  }

  function buildHeaderMap(fields, headerRow) {
    var normalized = (headerRow || []).map(normHeader);
    var map = {};
    fields.forEach(function (f) {
      for (var i = 0; i < normalized.length; i++) {
        var h = normalized[i];
        if (!h) continue;
        if (f.aliases.some(function (a) { return normHeader(a) === h; })) { map[f.key] = i; break; }
      }
    });
    return map;
  }

  function mapCompanyHeaders(headerRow) { return buildHeaderMap(CSV_COMPANY_FIELDS, headerRow); }
  function mapPostHeaders(headerRow) { return buildHeaderMap(CSV_POST_FIELDS, headerRow); }

  function normalizeImportedValue(key, value) {
    var v = text(value).trim();
    if (!v) return '';
    if (key === 'stage' || key === 'replyStatus' || key === 'source') return v;
    if (key === 'opportunityType') return OPPORTUNITY_TYPES.indexOf(v) > -1 ? v : '';
    if (key === 'priority') return PRIORITIES.indexOf(v) > -1 ? v : '';
    if (key === 'revenueConfidence' || key === 'fitConfidence') return CONFIDENCE_LEVELS.indexOf(v) > -1 ? v : '';
    if (key === 'classificationOverride') return CLASSIFICATIONS.indexOf(v) > -1 ? v : '';
    if (key === 'currency') return v.toUpperCase();
    if (key === 'fitScore' || key === 'fitService' || key === 'fitCommercial' || key === 'fitOpportunity' || key === 'fitMarket' || key === 'fitAccess' || key === 'probability') {
      var n = asNum(v);
      return clamp(n, 0, 100);
    }
    if (key === 'value') return asNum(v);
    return v;
  }

  function rowToCompanyData(cells, headerMap) {
    var data = {};
    Object.keys(headerMap).forEach(function (key) {
      var v = normalizeImportedValue(key, cells[headerMap[key]]);
      if (v !== '' && v != null) data[key] = v;
    });
    if (data.fitService != null || data.fitCommercial != null || data.fitOpportunity != null || data.fitMarket != null || data.fitAccess != null) {
      data.fitBreakdown = {
        service: data.fitService != null ? data.fitService : null,
        commercial: data.fitCommercial != null ? data.fitCommercial : null,
        opportunity: data.fitOpportunity != null ? data.fitOpportunity : null,
        market: data.fitMarket != null ? data.fitMarket : null,
        access: data.fitAccess != null ? data.fitAccess : null
      };
    }
    delete data.fitService; delete data.fitCommercial; delete data.fitOpportunity; delete data.fitMarket; delete data.fitAccess;
    return data;
  }

  function blankValue(v) { return v == null || String(v).trim() === ''; }

  function diffChanges(existing, data) {
    var changes = {};
    Object.keys(data).forEach(function (key) {
      if (key === 'name' || key === 'fitBreakdown') {
        if (key === 'fitBreakdown' && data.fitBreakdown && (!existing.fitBreakdown || !Object.keys(existing.fitBreakdown).some(function (k) { return existing.fitBreakdown[k] != null; }))) {
          changes.fitBreakdown = data.fitBreakdown;
        }
        return;
      }
      if (blankValue(existing[key]) && !blankValue(data[key])) changes[key] = data[key];
    });
    return changes;
  }

  function buildImportPlan(rows, companies) {
    var list = Array.isArray(companies) ? companies : [];
    var result = { headerMap: {}, items: [], counts: { new: 0, update: 0, duplicate: 0, review: 0, skipped: 0 }, error: '', headers: [] };
    if (!Array.isArray(rows) || rows.length < 2) { result.error = 'الملف فاضي أو مفيش فيه صفوف بيانات.'; return result; }
    var headerMap = mapCompanyHeaders(rows[0]);
    result.headerMap = headerMap;
    result.headers = rows[0];
    if (headerMap.name === undefined) {
      result.error = 'مفيش عمود اسم الشركة في الملف. الأعمدة المقبولة: الشركة / name / title.';
      return result;
    }
    var seenInFile = Object.create(null);
    var seenNamesInFile = Object.create(null);
    rows.slice(1).forEach(function (cells, idx) {
      var data = rowToCompanyData(cells, headerMap);
      if (!hasText(data.name)) { result.counts.skipped++; return; }
      var key = normName(data.name) + '|' + normPhone(data.phone, data.country);
      var base = { rowNumber: idx + 2, data: data, name: data.name, phone: text(data.phone) };
      if (seenInFile[key]) {
        result.items.push(Object.assign(base, { action: 'review', reason: 'السطر مكرر داخل نفس الملف — راجعه قبل الاستيراد.', matchId: seenInFile[key] }));
        result.counts.review++;
        return;
      }
      var nameKey = normName(data.name);
      if (seenNamesInFile[nameKey]) {
        result.items.push(Object.assign(base, {
          action: 'review',
          reason: 'اسم الشركة متكرر داخل الملف مع رقم مختلف أو ناقص — راجع قبل الإضافة أو الدمج.',
          matchId: seenNamesInFile[nameKey].matchId || ''
        }));
        result.counts.review++;
        return;
      }
      var candidates = list.filter(function (c) { return normName(c.name) === nameKey; });
      if (!candidates.length) {
        var newItem = Object.assign(base, { action: 'new', reason: 'شركة جديدة' });
        result.items.push(newItem);
        result.counts.new++;
        seenInFile[key] = 'new:' + (idx + 2);
        seenNamesInFile[nameKey] = { phone: normPhone(data.phone, data.country), matchId: 'new:' + (idx + 2) };
        return;
      }
      if (candidates.length > 1) {
        result.items.push(Object.assign(base, { action: 'review', reason: 'يوجد أكثر من شركة مسجلة بنفس الاسم — راجع قبل أي دمج.', matchId: '' }));
        result.counts.review++;
        return;
      }
      var existing = candidates[0];
      seenInFile[key] = existing.id;
      seenNamesInFile[nameKey] = { phone: normPhone(existing.phone, existing.country), matchId: existing.id };
      var p1 = normPhone(data.phone, data.country);
      var p2 = normPhone(existing.phone, existing.country);
      var sameName = true;
      if (p1 && p2 && p1 === p2) sameName = true;
      if (p1 && p2 && p1 !== p2) {
        result.items.push(Object.assign(base, { action: 'review', reason: 'نفس الاسم لكن رقم الهاتف مختلف — قد تكون شركة مختلفة.', matchId: existing.id }));
        result.counts.review++;
        return;
      }
      if ((!p1 && !p2) || (!p1 && p2) || (p1 && !p2)) {
        result.items.push(Object.assign(base, { action: 'review', reason: p1 || p2 ? 'نفس الاسم ورقم الهاتف ناقص في أحد الطرفين — راجع قبل الدمج.' : 'نفس الاسم بدون رقم هاتف. لا يتم الدمج تلقائيًا.', matchId: existing.id }));
        result.counts.review++;
        return;
      }
      var changes = diffChanges(existing, data);
      if (!Object.keys(changes).length) {
        result.items.push(Object.assign(base, { action: 'duplicate', reason: 'مطابقة كاملة ولا توجد بيانات جديدة — لن يتغير شيء.', matchId: existing.id, changes: {} }));
        result.counts.duplicate++;
      } else {
        result.items.push(Object.assign(base, { action: 'update', reason: 'تحديث الحقول الفاضية فقط', matchId: existing.id, changes: changes }));
        result.counts.update++;
      }
    });
    return result;
  }

  function applyImport(db, plan, decisions) {
    var companies = Array.isArray(db.companies) ? db.companies : [];
    var report = { created: 0, updated: 0, duplicated: 0, skipped: 0, reviewAsNew: 0, reviewAsUpdate: 0, reviewSkipped: 0, touchedIds: [] };
    (plan.items || []).forEach(function (item, i) {
      var action = decisions && decisions[i] ? decisions[i] : item.action;
      if (action === 'skip' || action === 'duplicate') {
        if (action === 'duplicate') report.duplicated++;
        else report.skipped++;
        return;
      }
      if (action === 'new') {
        var c = normalizeCompany(JSON.parse(JSON.stringify(item.data)));
        c.id = uid();
        c.created = c.created || todayISO();
        c.createdAt = c.createdAt || new Date().toISOString();
        c.contacts = [];
        c.activities = [];
        c.stageHistory = [];
        if (!isStage(c.stage)) c.stage = 'جديد';
        if (!hasText(c.replyStatus)) c.replyStatus = 'لم يتم التواصل';
        if (!hasText(c.source)) c.source = 'أخرى';
        if (!hasText(c.opportunityType)) c.opportunityType = inferOpportunityType(c);
        c.probability = c.probabilityManual ? c.probability : stageProbability(c.stage);
        appendActivity(c, 'استيراد', 'تم استيراد الشركة من ملف CSV.');
        companies.push(c);
        report.created++;
        if (item.action === 'review') report.reviewAsNew++;
        report.touchedIds.push(c.id);
        return;
      }
      if (action === 'update') {
        var target = null;
        if (item.matchId) target = companies.filter(function (x) { return x.id === item.matchId; })[0];
        if (!target) { report.skipped++; return; }
        var changes = item.changes || diffChanges(target, item.data);
        var changedFields = Object.keys(changes);
        changedFields.forEach(function (k) { target[k] = changes[k]; });
        if (changedFields.length) {
          appendActivity(target, 'تحديث من استيراد', 'تم استكمال الحقول الفاضية: ' + changedFields.join('، '));
          report.updated++;
          if (item.action === 'review') report.reviewAsUpdate++;
          report.touchedIds.push(target.id);
        } else report.duplicated++;
        return;
      }
      report.skipped++;
    });
    return report;
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  return {
    STAGES: STAGES,
    STAGE_KEYS: STAGE_KEYS,
    STAGE_MAP: STAGE_MAP,
    REPLY_STATUSES: REPLY_STATUSES,
    SOURCES: SOURCES,
    SECTORS: SECTORS,
    OPPORTUNITY_TYPES: OPPORTUNITY_TYPES,
    PRIORITIES: PRIORITIES,
    CONFIDENCE_LEVELS: CONFIDENCE_LEVELS,
    COUNTRIES: COUNTRIES,
    CURRENCIES: CURRENCIES,
    CLASSIFICATIONS: CLASSIFICATIONS,
    DEFAULT_FIT_WEIGHTS: DEFAULT_FIT_WEIGHTS,
    FIT_COMPONENTS: FIT_COMPONENTS,
    FOLLOWUP_DAYS: FOLLOWUP_DAYS,
    SECTOR_MODELS: SECTOR_MODELS,
    CSV_COMPANY_FIELDS: CSV_COMPANY_FIELDS,
    CSV_POST_FIELDS: CSV_POST_FIELDS,
    uid: uid,
    todayISO: todayISO,
    hasText: hasText,
    text: text,
    asNum: asNum,
    clamp: clamp,
    parseEmployees: parseEmployees,
    normPhone: normPhone,
    normName: normName,
    normHeader: normHeader,
    formatMoney: formatMoney,
    isStage: isStage,
    stageMeta: stageMeta,
    stageProbability: stageProbability,
    isOpenStage: isOpenStage,
    isClosedStage: isClosedStage,
    isLostStage: isLostStage,
    dealProgress: dealProgress,
    dealProbability: dealProbability,
    hasContactActivity: hasContactActivity,
    reachedStages: reachedStages,
    appendActivity: appendActivity,
    recordStageChange: recordStageChange,
    classify: classify,
    classificationLabel: classificationLabel,
    classificationColor: classificationColor,
    normalizeWeights: normalizeWeights,
    computeFit: computeFit,
    normalizeDb: normalizeDb,
    normalizeCompany: normalizeCompany,
    normalizeCampaign: normalizeCampaign,
    normalizePlan: normalizePlan,
    inferSector: inferSector,
    inferOpportunityType: inferOpportunityType,
    sectorModel: sectorModel,
    generateSalesPlan: generateSalesPlan,
    planToText: planToText,
    dashboardMetrics: dashboardMetrics,
    campaignMetrics: campaignMetrics,
    followupBuckets: followupBuckets,
    parseCSV: parseCSV,
    mapCompanyHeaders: mapCompanyHeaders,
    mapPostHeaders: mapPostHeaders,
    buildImportPlan: buildImportPlan,
    applyImport: applyImport
  };
});
