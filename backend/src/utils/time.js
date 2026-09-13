// تحويل "HH:MM:SS" إلى عدد ثوانٍ
function timeToSeconds(t) {
  if (!t) return 0;
  const parts = String(t).split(':').map(Number);
  const [h = 0, m = 0, s = 0] = parts;
  return (h * 3600) + (m * 60) + s;
}

// تحويل عدد الثواني إلى صيغة "HH:MM:SS"
function secondsToTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(x => String(x).padStart(2, '0')).join(':');
}

// --------------------------------------------------------------------------
// أدوات "قاعدة منتصف الليل" (Midnight Rule) — لتقسيم فترات زمنية (تشغيل ماكينة
// أو جلسة مشغّل) قد تعبر منتصف الليل أو حدود الأسبوع/الشهر، على أيام منفصلة،
// بدل نسب المدة كلها ليوم البداية فقط.
//
// كل الدوال هنا تتعامل مع نصوص DATETIME الخام بصيغة "YYYY-MM-DD HH:MM:SS" كما
// تُقرأ من MySQL عبر { dateStrings: true } — بدون أي تحويل لكائن Date بواسطة
// الـdriver، تفاديًا لأي انزياح منطقة زمنية. الحساب الداخلي يستخدم Date.UTC()
// فقط كأداة حساب مجردة (لا علاقة له بأي منطقة زمنية حقيقية) لتمثيل "الوقت
// كما هو مكتوب" بشكل قابل للطرح/المقارنة.
// --------------------------------------------------------------------------

// "YYYY-MM-DD HH:MM:SS" -> ميلي ثانية مجردة (لأغراض الحساب فقط، ليست Epoch حقيقي)
function naiveDtToMs(str) {
  const [datePart, timePart] = String(str).trim().split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = (timePart || '00:00:00').split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// عكسها: ميلي ثانية مجردة -> "YYYY-MM-DD"
function msToDateStr(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// إضافة عدد أيام لنص تاريخ "YYYY-MM-DD" -> نص تاريخ جديد
function addDaysToDateStr(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return msToDateStr(Date.UTC(y, mo - 1, d + days, 0, 0, 0));
}

// يقسّم فترة [startStr, endStr) — بعد قصّها على [rangeStartStr, rangeEndStr) —
// إلى مقاطع يومية منفصلة. كل مقطع يُنسَب بالكامل لليوم الذي وقع فيه فعليًا،
// فلا يوجد ازدواج ولا فقدان للثواني عند عبور منتصف الليل أو حدود المدى.
// يُرجع: [{ date: "YYYY-MM-DD", seconds: N }, ...] (فارغة لو لا تقاطع).
function splitIntervalByDay(startStr, endStr, rangeStartStr, rangeEndStr) {
  const rangeStart = naiveDtToMs(rangeStartStr);
  const rangeEnd = naiveDtToMs(rangeEndStr);
  let cursor = Math.max(naiveDtToMs(startStr), rangeStart);
  const end = Math.min(naiveDtToMs(endStr), rangeEnd);

  const segments = [];
  while (cursor < end) {
    const dayStr = msToDateStr(cursor);
    const nextMidnight = naiveDtToMs(addDaysToDateStr(dayStr, 1) + ' 00:00:00');
    const segEnd = Math.min(end, nextMidnight);
    segments.push({ date: dayStr, seconds: Math.round((segEnd - cursor) / 1000) });
    cursor = segEnd;
  }
  return segments;
}

module.exports = {
  timeToSeconds,
  secondsToTime,
  naiveDtToMs,
  msToDateStr,
  addDaysToDateStr,
  splitIntervalByDay
};
