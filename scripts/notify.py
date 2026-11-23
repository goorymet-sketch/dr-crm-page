"""
تنبيهات Digital Reach CRM على تليجرام.
بيشتغل على GitHub Actions كل 10 دقايق:
- يقرا الداتا من Firestore: crmData/simple (قراءة بس — مش بيعدل فيها)
- يبعت تنبيه قبل كل متابعة بـ 15 دقيقة
- يبعت ملخص الصبح الساعة 9
- بيحفظ اللي اتبعت في crmData/simpleNotify علشان مايكررش

Secrets في GitHub (تليجرام أو واتساب أو الاتنين):
  TELEGRAM_BOT_TOKEN        توكن البوت من BotFather
  CALLMEBOT_PHONE           رقمك بكود الدولة (مثال +201000504083)
  CALLMEBOT_APIKEY          الكود اللي CallMeBot بعتهولك على واتساب
  TEXTMEBOT_APIKEY          مفتاح TextMeBot (الرقم المربوط هو اللي بيبعت)
  TEXTMEBOT_RECIPIENT       رقمك اللي هيستقبل التنبيه بكود الدولة
  FIREBASE_SERVICE_ACCOUNT  محتوى ملف JSON بتاع Service account من Firebase
"""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

CRM_URL = "https://goorymet-sketch.github.io/dr-crm-page/crm.html"
REMIND_BEFORE_MIN = 15
DIGEST_HOUR = 9
DEFAULT_TZ = "Africa/Cairo"


# ---------------- منطق المتابعات (نفس منطق الصفحة) ----------------
def wa_number(p):
    p = re.sub(r"\D", "", str(p or ""))
    if p.startswith("00"):
        p = p[2:]
    if re.fullmatch(r"01[0125]\d{8}", p):
        p = "2" + p
    elif re.fullmatch(r"1[0125]\d{8}", p):
        p = "20" + p
    elif re.fullmatch(r"05\d{8}", p):
        p = "966" + p[1:]
    elif re.fullmatch(r"5\d{8}", p):
        p = "966" + p
    return p


def wa_link(db, phone, name):
    msg = (db.get("settings", {}).get("waMsg") or "").replace("{name}", name or "")
    return "https://wa.me/" + wa_number(phone) + "?text=" + quote(msg)


def parse_dt(s, tz):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s[:16]) if len(s) > 10 else datetime.fromisoformat(s[:10] + "T09:00")
        return d.replace(tzinfo=tz)
    except ValueError:
        return None


def collect(db, tz):
    comps = {c.get("id"): c.get("name", "") for c in db.get("companies", [])}
    out = []

    def add(key, when, tag, title, phone="", name="", note=""):
        d = parse_dt(when, tz)
        if d:
            out.append({"key": key + "@" + when, "due": d, "tag": tag, "title": title,
                        "phone": phone, "name": name, "note": note})

    for c in db.get("companies", []):
        if c.get("followUp"):
            add("co:" + c["id"], c["followUp"], "شركة", c.get("name", ""), c.get("phone"), c.get("contact") or c.get("name"), c.get("note", ""))
        for p in c.get("plan", []) or []:
            if p.get("due") and not p.get("done"):
                add("plan:" + c["id"] + ":" + p["id"], p["due"], "خطة " + c.get("name", ""), p.get("text", ""), note=p.get("note", ""))
    for x in db.get("sales", []):
        if x.get("followUp"):
            extra = comps.get(x.get("companyId")) or x.get("company") or ""
            add("sales:" + x["id"], x["followUp"], "مبيعات", x.get("name", "") + (" — " + extra if extra else ""),
                x.get("phone"), x.get("name"), x.get("note", ""))
    for x in db.get("broker", []):
        if x.get("followUp"):
            add("broker:" + x["id"], x["followUp"], "وساطة", x.get("name", "") + (" — " + x["contact"] if x.get("contact") else ""),
                x.get("phone"), x.get("contact") or x.get("name"), x.get("note", ""))
    for x in db.get("tasks", []):
        if x.get("followUp") and not x.get("done"):
            add("task:" + x["id"], x["followUp"], "مهمة", x.get("title", ""), x.get("phone"), "", x.get("note", ""))
    out.sort(key=lambda f: f["due"])
    return out


def fmt_item(db, f):
    t = f"🔔 <b>{html.escape(f['tag'])}</b>: {html.escape(f['title'])}\n🕒 {f['due'].strftime('%d/%m %I:%M %p')}"
    if f["note"]:
        t += "\n📝 " + html.escape(f["note"][:200])
    if f["phone"]:
        t += f"\n💬 <a href=\"{html.escape(wa_link(db, f['phone'], f['name']))}\">افتح واتساب</a>"
    return t


def plan_messages(db, state, now):
    """يرجع (الرسايل، state الجديدة). مفصول علشان يتختبر من غير نت."""
    tz = now.tzinfo
    sent = dict(state.get("sent", {}))
    items = collect(db, tz)
    msgs = []

    due = [f for f in items if f["due"] <= now + timedelta(minutes=REMIND_BEFORE_MIN) and f["key"] not in sent]
    recent = [f for f in due if f["due"] >= now - timedelta(hours=2)]
    old = [f for f in due if f["due"] < now - timedelta(hours=2)]
    for f in recent[:10]:
        msgs.append(fmt_item(db, f))
    if len(recent) > 10:
        msgs.append(f"➕ وفيه {len(recent) - 10} متابعة كمان دلوقتي — افتح الـ CRM:\n{CRM_URL}")
    if old:
        msgs.append(f"⚠️ عندك {len(old)} متابعة متأخرة فاتت.\nافتح تاب المتابعة: {CRM_URL}")
    for f in due:
        sent[f["key"]] = now.isoformat()

    today = now.strftime("%Y-%m-%d")
    if now.hour >= DIGEST_HOUR and state.get("lastDigest") != today:
        end = now.replace(hour=23, minute=59)
        todays = [f for f in items if now.replace(hour=0, minute=0) <= f["due"] <= end]
        late = [f for f in items if f["due"] < now.replace(hour=0, minute=0)]
        lines = [f"☀️ <b>صباح الخير يا محمد — متابعات النهارده ({len(todays)})</b>"]
        for f in todays[:15]:
            lines.append(f"• {f['due'].strftime('%I:%M %p')} — {html.escape(f['tag'])}: {html.escape(f['title'])}")
        if not todays:
            lines.append("مفيش متابعات متسجلة النهارده.")
        if late:
            lines.append(f"\n🔴 متأخر: {len(late)}")
        lines.append(f"\n{CRM_URL}")
        msgs.append("\n".join(lines))
        state["lastDigest"] = today

    # تنظيف: امسح المفاتيح الأقدم من 30 يوم
    cutoff = (now - timedelta(days=30)).isoformat()
    state["sent"] = {k: v for k, v in sent.items() if v >= cutoff}
    return msgs, state


# ---------------- تليجرام ----------------
def tg(token, method, **params):
    r = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=30)
    r.raise_for_status()
    return r.json()


def find_chat_id(token):
    res = tg(token, "getUpdates").get("result", [])
    for u in reversed(res):
        m = u.get("message") or u.get("edited_message")
        if m and m.get("chat", {}).get("type") == "private":
            return m["chat"]["id"]
    return None


# ---------------- واتساب (CallMeBot — مجاني للاستخدام الشخصي) ----------------
def to_whatsapp_text(t):
    t = re.sub(r'<a href="([^"]+)">[^<]*</a>', r"\1", t)
    t = t.replace("<b>", "*").replace("</b>", "*")
    return html.unescape(re.sub(r"<[^>]+>", "", t))


def textmebot_send(recipient, apikey, text):
    r = requests.get("https://api.textmebot.com/send.php",
                     params={"recipient": recipient, "apikey": apikey, "text": to_whatsapp_text(text)}, timeout=60)
    if r.status_code != 200 or "error" in r.text.lower()[:300]:
        print("TextMeBot رجّع خطأ — راجع الرقم والـ apikey والاشتراك.")


def wa_send(phone, apikey, text):
    r = requests.get("https://api.callmebot.com/whatsapp.php",
                     params={"phone": phone, "text": to_whatsapp_text(text), "apikey": apikey}, timeout=60)
    if r.status_code != 200 or "ERROR" in r.text.upper()[:300]:
        print("CallMeBot رجّع خطأ — راجع الرقم والـ apikey.")


# ---------------- التشغيل ----------------
def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    wa_phone = os.environ.get("CALLMEBOT_PHONE", "").strip()
    wa_key = os.environ.get("CALLMEBOT_APIKEY", "").strip()
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    test = os.environ.get("SEND_TEST") == "1"
    use_wa = bool(wa_phone and wa_key)
    tmb_key = os.environ.get("TEXTMEBOT_APIKEY", "").strip()
    tmb_to = os.environ.get("TEXTMEBOT_RECIPIENT", "").strip()
    use_tmb = bool(tmb_key and tmb_to)
    if not token and not use_wa and not use_tmb:
        print("مفيش Telegram ولا WhatsApp متضافين في Secrets — مفيش حاجة هتتبعت.")
        return 0

    state, db, ref = {}, None, None
    if sa:
        import firebase_admin
        from firebase_admin import credentials, firestore
        firebase_admin.initialize_app(credentials.Certificate(json.loads(sa)))
        fs = firestore.client()
        snap = fs.collection("crmData").document("simple").get()
        db = snap.to_dict() if snap.exists else {}
        ref = fs.collection("crmData").document("simpleNotify")
        st = ref.get()
        state = st.to_dict() if st.exists else {}
    else:
        print("FIREBASE_SERVICE_ACCOUNT مش متضاف — هبعت رسالة تجربة بس.")

    chat_id = state.get("chatId")
    if token and not chat_id:
        chat_id = find_chat_id(token)
        if chat_id:
            state["chatId"] = chat_id
        else:
            print("تليجرام: ابعت /start للبوت الأول.")

    def send(text):
        if token and chat_id:
            tg(token, "sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", disable_web_page_preview=True)
        if use_wa:
            wa_send(wa_phone, wa_key, text)
        if use_tmb:
            textmebot_send(tmb_to, tmb_key, text)

    if db is None or test:
        send("✅ تنبيهات Digital Reach CRM شغالة. هيوصلك تنبيه قبل كل متابعة بـ 15 دقيقة، وملخص كل يوم الساعة 9 الصبح.")
        if db is None:
            return 0

    tz = ZoneInfo((db.get("settings") or {}).get("tz") or DEFAULT_TZ)
    now = datetime.now(tz)
    msgs, state = plan_messages(db, state, now)
    for m in msgs:
        send(m)
    ref.set(state)
    print(f"اتبعت {len(msgs)} رسالة.")  # من غير تفاصيل العملاء علشان اللوج عام
    return 0


if __name__ == "__main__":
    sys.exit(main())
