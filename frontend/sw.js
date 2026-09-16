// Service Worker بسيط — غرضان فقط:
// 1) شرط تقني لازم عشان Chrome يعتبر الموقع "قابل للتثبيت" (PWA حقيقي، مش مجرد اختصار).
// 2) اعتراض طلب POST القادم من نظام المشاركة (Web Share Target) لما المستخدم يعمل
//    "مشاركة" ملف من واتساب لموقعنا، وتخزين الملف مؤقتًا في IndexedDB، ثم تحويل
//    المستخدم لصفحة share-target.html (بطلب GET عادي) اللي بتقرأ الملف وتكمل الرفع.

const DB_NAME = 'laser-share-target';
const STORE_NAME = 'pending-file';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSharedFile(file) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(file, 'current');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// بيسجّل آخر محاولة مشاركة (نجحت أو فشلت) عشان نقدر نشخّص المشكلة من صفحة share-target.html
async function saveDebugInfo(info) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(info, 'debug');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    // تجاهل — التشخيص نفسه مش لازم يوقف عملية المشاركة
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // اعتراض طلب المشاركة فقط (POST على share-target.html) — أي طلب تاني يمر عادي بدون تدخل
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target.html')) {
    event.respondWith((async () => {
      const log = { time: new Date().toISOString(), step: 'بدأ الاعتراض' };
      try {
        const formData = await event.request.formData();
        log.step = 'قرأ formData بنجاح';
        log.keys = Array.from(formData.keys()).join(', ') || '(فاضي)';
        const file = formData.get('sharedFile');
        if (file) {
          log.step = 'لقى الملف: ' + file.name + ' (' + file.size + ' بايت)';
          await saveSharedFile(file);
          log.step = 'اتحفظ في IndexedDB بنجاح';
        } else {
          log.step = 'formData وصلت لكن مفيش حقل sharedFile فيها';
        }
      } catch (e) {
        log.step = 'خطأ: ' + (e && e.message ? e.message : String(e));
      }
      await saveDebugInfo(log);
      return Response.redirect('./share-target.html?shared=1', 303);
    })());
  }
});
