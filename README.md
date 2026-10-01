# qwen-api-bridge

جسر برمجي لـ API الداخلي لـ `chat.qwen.ai`: أداة تسجيل للجلسات + أداة مستقلة لكل نقطة نهاية.

**3MH TECHNOLOGIES** — [الموقع](https://3mh.pages.dev/) · [تيليجرام](https://t.me/j49_c)

## البنية المكتشفة

| | |
|---|---|
| Chat API | `https://chat.qwen.ai/api/v2` |
| Auth API | `https://auth.qwen.ai/api/v2` |
| Envelope | `{ success: boolean, request_id: string, data: any }` |
| البث | SSE (`text/event-stream`) مع `[DONE]` |
| عدد المسارات في الـ bundle | 116 |
| الأدوات المولّدة | 84 في 14 مجموعة (7 مؤكدة ميدانياً) |

المسارات استخرجت من حزمة الواجهة `qwen-chat-fe/0.3.12/js/main.js`.

## المجموعات

`auth` · `users` · `chats` · `messages` · `completions` · `models` · `configs` · `files` · `tasks` · `tts` · `community` · `feedback` · `member` · `memory`

## الملفات

```
src/
  routes.js          جدول المسارات (مصدر الحقيقة) + حلّ القوالب + قائمة `guarded`
  tools/build.js     يحوّل كل مسار إلى أداة قابلة للاستدعاء
  client.js          عميل HTTP: تظليل الكوكيز، إعادة المحاولة، فكّ الـ envelope
  session.js         إدارة الكوكيز (تُحفظ في .session.json)
  sse.js             محلل SSE
  chat.js            بناء حمولة الإكمال + طيّ البث إلى نص
  inpage.js          نقل يعمل داخل الصفحة (للبيئات التي تحجب egress من Node)
  recorder.js        أداة التسجيل → HAR
  cli.js             واجهة سطر الأوامر
```

### حالة الطلب

الحافة تعيد `200` على السطر وتحطّ الحالة الحقيقية في `x-actual-status-code`.
`client.js` يقرأها عبر `effectiveStatus()`، لذا:

- فرع `401 → refresh()` يعمل فعلياً (كان ميتاً عند قراءة `res.status`).
- `AntiBotError` يُرمى إذا جاء جسم التحدي في مسار API متوقع JSON.
- مسار الـ stream يرفض أي `content-type` غير `text/event-stream` فوراً
  بدل أن يدخل `readSSE` وينتظر إلى أجل غير مسمى.
- `stream()` يفرض مهلة افتراضية `DEFAULT_STREAM_TIMEOUT_MS` (60 ثانية)،
  تُمرَّر عبر `AbortSignal`؛ تعطيلها بـ `timeout: 0`.

```js
const c = QwenClient.fromDisk();
try {
  for await (const ev of c.stream(ROUTES_COMPLETION, payload)) { ... }
} catch (e) {
  if (e.code === "AntiBotChallenge") // استخدم جلسة متصفح عبر inpage.js
  if (e.code === "StreamTimeout")   // البث عُلّق؛ أعد المحاولة أو وسّع المهلة
  if (e.code === "Unauthorized")    // جلسة منتهية؛ auth-import مجدداً
}
```

## الاستخدام

```bash
npm run routes     # جدول المسارات مع حالة التأكيد
npm run tools      # قائمة الأدوات الـ 84
node src/cli.js models    # كتالوج النماذج
node src/cli.js configs   # رايات الميزات والأدوات
node src/cli.js tts       # الأصوات واللغات
```

### الأداة

```bash
# مرة واحدة: انسخ document.cookie من المتصفح بعد تسجيل الدخول
node src/cli.js auth-import "cna=...; sca=...; ..."
node src/cli.js auth-status
```

### جلسة جاهزة للدخول (بايثون) — `qwen_session.py`

أداة مستقلة ببايثون (بدون تبعيات خارجية) تُولّد جلسة عبر **API المصادقة مباشرة**
وتحفظها في `j49_c.txt`:

```bash
# إنشاء حساب عبر الـ API ثم حفظ الجلسة
python qwen_session.py signup --email you@example.com --password SECRET [--name "You"]

# الدخول بالبريد وكلمة السر (يُطلب كلمة السر مخفيًّا إن حُذفت)
python qwen_session.py signin --email you@example.com

# الدخول برمز OTP
python qwen_session.py otp-request --email you@example.com
python qwen_session.py otp-verify --email you@example.com --code 123456

# بديل: استيراد جلسة متصفح جاهزة
python qwen_session.py auth-import "<cookie string أو session JSON أو ملف أو - لـ stdin>"

# الفحص والتجهيز
python qwen_session.py status                       # هل الجلسة داخلة؟
python qwen_session.py export                       # طباعة Cookie/Authorization
```

المسارات المستخدمة (من `routes.js`): `POST /auths/signup` · `POST /auths/signin` ·
`POST /auths/otp/email/request` · `POST /auths/otp/email/verify`.

خيارات المشتركة: `--token` (auth-import)، `--out` (اسم ملف آخر)،
`--no-verify` (تخطي فحص الحالة الحيّ)، `--force` (الحفظ رغم فشل الفحص).

التحقق يحاكي `client.js`: قراءة `x-actual-status-code`، فحص علامات تحدي
Alibaba + صفحة كابتشا Aliyun WAF، وتجديد الكوكيز عبر `/auths/refresh` عند 401
مرة واحدة. **الأداة لا تحلّ الكابتشا ولا تتجاوز الحماية:** إن أعاد الـ WAF
صفحة التحدي على أي POST يفشل الأمر برسالة واضحة، والبديل هو تسجيل دخول واحد
في المتصفح ثم `auth-import` (كما في README → حدود معروفة).

الصيغة المحفوظة JSON متوافقة مع سكربت الجسر نفسه:

```bash
node src/cli.js auth-import j49_c.txt   # يقرأها مباشرة
node src/cli.js auth-status
```

### التسجيل

```bash
# 1) شغّل كروم مع منفذ التصحيح
chrome --remote-debugging-port=9222
# 2) افتح chat.qwen.ai وسجّل الدخول وتصفّح كل الميزات
# 3) سجّل
node -e "import('./src/recorder.js').then(async m => {
  const r = await m.recordViaCDP({ port: 9222 });
  console.log(r.summary());
  console.log(r.save());
})"
```

المخرجات HAR صالح للفتح في DevTools، ويُستخدم لترقية المسارات من `[inferred]` إلى `[verified]`.

### في صفحة متصفح مفتوحة

`src/inpage.js` يوفّر نفس الأدوات داخل الصفحة، متصلاً بالجلسة القائمة:

```js
// عبر browser.evaluate
const Q = <PAGE_SOURCE>;
await Q.session();          // من أنا
await Q.models();           // كل خيارات النماذج
await Q.config();           // رايات الميزات
await Q.chat("اشرح لي الـ SSE", { thinking: true });
```

## خيارات الموقع المؤكدة (طُلبت من واجهة حية)

3 نماذج، كلٌّ منها نافذة سياق 1,000,000 رمز مع قدرات
audio · document · video · vision · thinking · search:

| النموذج | chat_types |
|---|---|
| `qwen3.7-plus` | t2t t2v t2i image_edit search artifacts web_dev deep_research travel learn slides vqa translate |
| `qwen3.8-max` | نفس الأنواع الـ 13 |
| `qwen3.8-omni-flash` | t2t t2i search vqa translate + citations |

`/api/v2/tts/config` يعيد `omni_speakers` · `audio_tts_speakers` · `omni_language` · `audio_tts_language`.

## حدود معروفة

1. **وضع الزوار محجوب.** الواجهة تفتح نافذة "Log in" بدل الإرسال، و`GET /api/v2/auths/` يعيد `401 Unauthorized`. كل ما يتجاوز الجلسات (سجل المحادثات، الملفات، الذاكرة، العضوية) يتطلب تسجيل دخول.
2. **الحماية المضادة للبوتات.** طلب `POST /api/v2/chat/completions` من سكربت بصلاحية ضيف يعود بحالة 200 لكن مع تحدي Alibaba (`_____tmd_____/punishTextFetch`، `x5secdata`). **التعليق لم يعد صامتاً:** `client.js` يفحص `content-type` قبل دخول `readSSE`، ويضع مهلة 60 ثانية على البث، ويرمي `AntiBotError` (`code: "AntiBotChallenge"`) إذا وجد علامات التحدي. النتيجة خطأ واضح خلال ثوانٍ بدل انتظار مفتوح. هذا المشروع **لا يتجاوز** تلك الحماية — لا يوجد أي كود لتوقيع `x5secdata` أو محاكاة `gridConnectGet`. جلب رد حقيقي يتم عبر جلسة متصفح مسجّل الدخول.
3. **`egress` من Node.** في البيئات المحجوبة يجب استخدام `inpage.js` بدل `client.js`.
4. **حقول `inferred`.** المسارات غير المؤكدة تستخدم methods مستنتجة من REST. سجّل جلسة حقيقية لترفع دقتها.
5. **حقل `guarded`.** 54 من الأداة الـ84 تحمل `guarded: true` — وهي مسارات يطابقها `checkApiPath` في حزمة `main.js` (قائمة `Kh` الـ22، مطابقة substring). هذه بيانات مسار تشرح أين تُطبَّق الحماية، ولا تؤثر في أي طلب.
6. **ملفات الجلسة سرّية.** `.session.json` (كوكيز + `accessToken`) و`j49_c.txt` مُستثناة في `.gitignore`. لا ترفعهما إلى مستودع عام.

## تنبيه

هذا المشروع يتعامل مع واجهات **غير موثّقة** لـ `chat.qwen.ai`، ومذكور فيه أن
`/auths/signup` و`/auths/signin` وما شابه نقاط المصادقة الحقيقية للموقع.

- استخدم حسابك الخاص فقط؛ الحسابات المولّدة آلياً قد تخالف شروط الخدمة.
- الأداة **لا تتجاوز** حماية Alibaba/Aliyun، ولا تحلّ الكابتشا.
- راجع شروط خدمة Alibaba قبل أي استخدام آلي.
- **لا تنشر أبداً** ملفات الجلسة أو الكوكيز أو التوكن.

---

## حقوق النشر

جميع الحقوق محفوظة © **3MH TECHNOLOGIES**

هذا المشروع منشور تحت رخصة **MIT** (انظر `LICENSE`). الكود تحت رخصة مفتوحة، لكن **الاسم والعلامة التجارية والحقوق محفوظة** ولا يُسمح باستخدامهما لإبرام منتجات مشتقة دون إذن كتابي.

- الموقع: [https://3mh.pages.dev/](https://3mh.pages.dev/)
- تيليجرام: [@j49_c](https://t.me/j49_c)
- المصدر: [github.com/3MH-Technologies/qwen-api-bridge](https://github.com/3MH-Technologies/qwen-api-bridge)

> هذا المشروع غير رسمي ولا تابع لشركة Alibaba أو Qwen. أسماء المنتجات والعلامات المذكورة ملك لأصحابها.
