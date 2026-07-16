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

module.exports = { timeToSeconds, secondsToTime };
