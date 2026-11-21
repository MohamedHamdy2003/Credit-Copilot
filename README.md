# Credit Copilot

بيئة تدريب لتقييم القرض الشخصي PL-100 وقرض السيارة AL-200 باستخدام React وNestJS وPostgreSQL/pgvector وMastra. كل البيانات تدريبية، والإصدار يحتاج قرارًا بشريًا.

## Quick start

المتطلبات: Node24، pnpm11.25.0، Docker Desktop/Compose v2 وGit. من جذر المشروع:

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

ضع `GEMINI_API_KEY` و`DEMO_PASSWORD` محليًا في `.env`؛ لا ترسلهما في الشات أو Git. أنشئ المفتاح من [Google AI Studio](https://aistudio.google.com/apikey)، وفق [تعليمات المزود الرسمية](https://aistudio.google.com/docs/api-key). استخدم نموذجًا متاحًا ضمن quota حسابك؛ لا يلزم شراء اشتراك، ولا نفترض تكلفة صفرية أو quota مضمونة.

```powershell
pnpm dev
```

الأمر يشغّل Docker DB وينتظر health، ثم migration CLI الصريح، ثم API والويب. الافتراضي: `http://localhost:5173` وOpenAPI على `http://127.0.0.1:3000/api/docs`. Ctrl+C يوقف API/الويب ويحتفظ بقاعدة البيانات. افحص Docker Desktop لو البداية فشلت؛ لو المنفذ مشغول غيّر PORT/WEB_ORIGIN قبل التشغيل. لا يوجد deployment تلقائي.

في terminal آخر:

```powershell
pnpm seed
pnpm seed:users
```

seed يفهرس مستندات السياسات والتسعير والإجراءات من الـmanifest. تكرار الأمر يرجع skipped. حسابات Demo تستخدم كلمة المرور المحلية المحددة بطول 12–256 حرفًا. الحسابات هي `loan-officer`، و`credit-officer` بحد 250,000، و`senior-credit-officer` بحد 500,000، و`head-credit` بحد 1,000,000. إعادة seed:users تحدّث كلمات المرور وتلغي الجلسات. حسابات fixture CLI لا تصلح للدخول.

## 5-Minute Demo Path

1. سجّل دخول loan-officer. من Knowledge راجع المصادر؛ الرفع يحتاج canIngest وهو متاح لحساب head-credit.
2. اسأل `What is the maximum debt burden ratio in CP-2024?` ثم CP-2025. الاقتباسات المتحققة بتظهر مع المصدر والتاريخ. راجع 50% و45%.
3. اسأل عن crypto-backed loans: يجب رفض السؤال لغياب المصدر. أسئلة التعارض تعرض اقتباسات السياسة والمنتج/التعميم، بمراجع زمنية صريحة.
4. جرّب Calculate: مبلغ300000، دخل30000، التزامات4000،60 شهرًا؛2025-04-03 يعطي EMI8630.39 وmaximum330000. غيّر التاريخ إلى2024-12-01 فيصبح maximum382000. الحساب وحده ليس موافقة.
5. Add application → APP-001 → Run assessment. تابع المراحل أثناء التقييم، وبعد الحفظ افتح تبويب Workflow لمراجعة سجلها. Strict افتراضي ونقص البطاقة يؤدي لإحالة CP-8/PS-7. الأصل متاح للتنزيل من صفحة الطلب.
6. لتجربة مسار الاعتماد، فعّل ALLOW_DEMO_MODE=true محليًا وأعد تشغيل API ثم اختار Demo صراحة. APP-001 يعطي توصية pending_approval؛ افتراض وجود البطاقة وverified=false واضحان. APP-004 يُحال للاحتيال بدون استدعاء نموذج. APP-002/003/005 تظل إحالات لنقص إثبات probation؛ لا نفترض اكتماله.
7. سجّل دخول credit-officer وحاول اعتماد توصية 300,000. السيرفر يرفض تجاوز 250,000. مستخدم Senior مستقل يسجل التبرير والاعتماد ثم يصدر العرض بتاريخ صرف مناسب. افتح View issued offer ونزّل خطاب الـPDF وجدول الأقساط. الخطاب يوضّح افتراض الـDemo.
8. في Senior referral queue سجّل انتظار الأدلة/إعادة تقييم أو الإقرار بسجل Fraud Unit الداخلي. الملاحظة لا تلغي نقص الأدلة ولا تغيّر القرار. PM-9 يتيح طلب السبب المكتوب بعد رفض بشري صحيح خلال30 يومًا، بلا استئناف آلي أو تعديل قرار. توجد رحلة اختبار مستقلة لهذا المسار؛ لا ترفض pack ناقص الأدلة لفرض مثال.

## Evaluation and checks

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:integration
pnpm evaluate:core:offline
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm evaluate --vector
pnpm evaluate --hybrid
pnpm evaluate --rewrite
pnpm evaluate --offline-agents
pnpm evaluate --agents
```

integration وcore:offline وe2e تستخدم قاعدة تنتهي بـ_test؛ شغّلها بالتتابع. لو غير موجودة، أنشئها مرة عبر `docker compose exec -T db psql -U copilot -d postgres -c "CREATE DATABASE credit_copilot_test"`. e2e تفرغ حسابات/طلبات قاعدة الاختبار، وتشغّل API4304 وVite5174. الصور/traces خارج Git. offline لا يقيس جودة semantic/LLM.

`pnpm evaluate` يشغّل15 حالة فعلية عبر Gemini في قاعدة منفصلة تنتهي بـ_eval، وينشئها إن كانت صلاحية المستخدم تسمح. لا يغيّر بيانات الطلبات في قاعدة التطبيق. يقرأ cache موثوقًا لمتجهات السياسات المطابقة للنص/model/dimensions، بينما embeddings الأسئلة والاستدعاءات التوليدية live. يحفظ كل تشغيل، حتى الفاشل، في `artifacts/evaluation/`، ويخرج بكود فشل إذا لم تمر البوابة. يلزم مفتاح وquota؛ هذا الأمر يستهلكها.

الحالات الذهبية في `data/evaluation/cases.json` والتقارير الفعلية في `data/evaluation/results/`. الـvector والـhybrid عدّوا 15/15 وhit@5 كان 4/4 في الوضعين على الأسئلة القابلة للإجابة. شغّل `pnpm evaluate --vector` و`pnpm evaluate --hybrid` و`pnpm evaluate --rewrite` للمقارنة. البحث الافتراضي يدمج BM25 وpgvector بـRRF ويضيف مصطلحات بحث من قاموس ثابت. التقييم مع إعادة الصياغة حقق 15/15 وhit@5 ‏4/4. التفاصيل وتقارير الفشل في `docs/EVALUATION.md`. `pnpm evaluate:smoke` يحتفظ بفحص الـvector القديم لخمس حالات، و`pnpm evaluate:offline` يشغّل regression tests بسيطة من غير DB.

## تقييم الطلبات باستخدام الـAgents

اضبط `ASSESSMENT_ORCHESTRATION=agents` لتجربة ثلاث أدوات Mastra من خلال الـAPI أو
`pnpm assess`. السيرفر بيحدد مدخلات كل أداة: بيانات منقّحة، سياسة بالتاريخ
والمنتج، أو نتيجة التقييم للمذكرة المحسوبة. كل دور له محاولة تخطيط واحدة.
لو طلب الأداة غير صالح أو التخطيط تعذّر، نفس مرحلة الـworkflow بتشتغل مباشرة.
سجل التقييم بيحفظ نتيجة كل استدعاء واستخدام التخطيط. الفحص المعزول بيشتغل
بـ`pnpm evaluate --offline-agents` أو بـ`pnpm evaluate --agents` مع Gemini.
لو احتجت فاصل بين طلبات التوليد في القياس اضبط
`EVALUATION_GENERATION_INTERVAL_MS` بالمللي ثانية. الإعداد خاص بالتقييم.

## تجربة قرض السيارة التجريبي

من Applications اختار `AUTO-001`، أو شغّل `pnpm assess AUTO-001 --demo` بعد
تمكين Demo. تقييم العينة يحسب تمويل 250,000 جنيه من سعر السيارة 350,000
ودفعة موثقة 100,000. بند PS-9 يشترط دفعة لا تقل عن 25%. العينة `AUTO-002`
تحت الحد وتنتظر قرار رفض بشري، و`AUTO-003` تتحوّل لمراجعة بشرية لأن سعر
السيارة غير موثق. كل العينات تحفظ نتيجة Strict وDemo حسب الأدلة.
في Policy questions اختار Auto loan لعرض مصادر المنتج وتواريخه فقط.

## تشغيل Ollama كبديل محلي

التحويل اختياري. شغّل حاوية Ollama وحمّل النموذج مرة واحدة، وبعدها فعّل
`OLLAMA_FALLBACK_ENABLED=true` في `.env` وأعد تشغيل الـAPI. خدمة Compose متاحة
على جهازك فقط، وخصائص Ollama Cloud مقفولة. [دليل Ollama المحلي](https://docs.ollama.com/faq)

```powershell
docker compose --profile local-llm up -d ollama
docker compose exec -T ollama ollama pull qwen3:4b-instruct-2507-q4_K_M
pnpm evaluate:fallback
```

Gemini بيظل المزود الأساسي. لو التوليد فشل بسبب quota أو timeout أو عطل مؤقت
بعد محاولات Gemini، التطبيق بيجرّب Ollama مرة على نفس المدخلات المنقّحة.
استرجاع السياسات وفهرستها بيعتمدوا على Gemini embeddings. لو embedding السؤال
تعذّر، الـAPI بيرجع خطأ خدمة 503. تقييم `pnpm evaluate` يقيس Gemini، وفحص
`pnpm evaluate:fallback` بيحقن تعطل Gemini ويستخدم Ollama فعليًا لاختبار استخراج
APP-001، المذكرة المحسوبة واقتباس سياسة محدد. تقرير الفحص المنقّح في
`artifacts/evaluation/`.

## Configuration

كل المتغيرات الحالية في `.env.example`. أعد تشغيل API عند تغييرها؛ الأسرار تبقى على السيرفر.

| Variable | Default / use |
|---|---|
| DATABASE_URL | PostgreSQL local54329/credit_copilot؛ migrations عبر CLI، synchronize=false |
| EVALUATION_DATABASE_URL | اختياري؛ إن غاب يُشتق اسم _eval من DATABASE_URL |
| PORT / WEB_ORIGIN | 3000 / http://localhost:5173؛ origin لازم يطابق عنوان المتصفح |
| GEMINI_API_KEY | سر محلي؛ غير مطلوب لاختبارات fake/offline |
| LLM_PROVIDER | gemini هو المزود الأساسي |
| OLLAMA_FALLBACK_ENABLED | false افتراضيًا. true يفعّل التحويل للتوليد المحلي |
| OLLAMA_BASE_URL | http://127.0.0.1:11434 افتراضيًا. يقبل عنوان HTTP محلي فقط |
| OLLAMA_MODEL | qwen3:4b-instruct-2507-q4_K_M افتراضيًا. لازم النموذج يكون محمّل في Ollama |
| OLLAMA_TIMEOUT_MS | 120000 مهلة محاولة التوليد المحلية بالمللي ثانية |
| GENERATION_MODEL | gemini-3.5-flash-lite؛ اسم النموذج المسجل في القياس |
| GEMINI_BILLING_TIER | `unknown` افتراضيًا. اضبط `confirmed_free` بعد التحقق من أن مشروع المفتاح على Gemini Free Tier |
| EMBEDDING_MODEL / EMBEDDING_DIMENSIONS | gemini-embedding-001 /768؛ تغييرهما يحتاج إعادة فهرسة وbaseline جديد |
| RETRIEVAL_STRATEGY | hybrid افتراضيًا؛ vector لتشغيل البحث الدلالي وحده |
| RETRIEVAL_MIN_SIMILARITY | 0.65 عتبة cosine للأدلة |
| QUERY_REWRITE_MAX_EXPANSIONS | 2 مصطلح إضافي كحد أقصى افتراضيًا في hybrid. من 0 إلى 4. قيمة 0 توقف إعادة الصياغة |
| ASSESSMENT_ORCHESTRATION | workflow افتراضيًا. agents يفعّل الأدوات المحددة لمراحل الاستخراج والسياسة والمذكرة |
| ASSESSMENT_MODE / ALLOW_DEMO_MODE | strict /false؛ Demo يحتاج تمكينًا واختيارًا صريحًا لبيانات synthetic |
| UPLOAD_MAX_BYTES | 10485760؛ PDF/CSV/MD، وحد100 صفحة PDF، بلا OCR |
| DEMO_PASSWORD | محلي12–256 حرفًا لإنشاء حسابات التدريب |
| SESSION_TTL_HOURS / COOKIE_SECURE | 8 /false للتطوير؛ Secure يحتاج HTTPS |
| TEST_DATABASE_URL | اختياري للاختبارات؛ الاسم يجب أن ينتهي _test |
| API_PROXY_TARGET | اختياري عند تشغيل Vite منفردًا؛ pnpm dev يضبطه حسب PORT |
| POSTGRES_PASSWORD | إعداد Compose اختياري؛ الافتراضي copilot_local المحلي، ويجب أن يطابق DATABASE_URL |

`data/config/review-calendar.json` يضبط عطلة الأسبوع والإجازات لتقدير PM-4 فقط: الجمعة/السبت افتراضيًا، بلا إجازات رسمية مختلقة. مهلة PM-9 هي30 يومًا تقويميًا من الرفض المسجل بتوقيت القاهرة، شاملة اليوم30؛ مصدر الملفات لا يوفر تاريخ إخطار منفصلًا.

## API, privacy and limits

المسارات تحت `/api/v1` وموثقة في OpenAPI. Login يرجع HttpOnly/SameSite cookie وcsrfToken؛ أرسل cookie و`x-csrf-token` مع POST. عند التقييم أرسل Idempotency-Key ثابتًا للمحاولة نفسها؛ الرد الناجح يتكرر بنفس run، وتغيير mode يحتاج مفتاحًا مختلفًا. job واحد لكل طلب، منع القرار أثناء reassessment، وإغلاق المحاولة العالقة بعد15 دقيقة عند محاولة جديدة. النتائج المتأخرة لا تستبدل الأحدث، والطلب الصادر عرضه لا يعاد تقييمه.

- Knowledge يعرض السياسات ويدعم multipart `files` لدفعات 1–20 مع نتيجة كل ملف. الـmanifest يحدد المصادر المعتمدة حسب المنتج.
- Applications يدعم multipart `file` أو اختيار fixture. قبول الـPDF مرتبط ببصمة الحزمة المعتمدة. بيانات العملاء محفوظة في مخزن الحالات.
- Reviews/decisions/offers: الصلاحيات والمبلغ والنسخة وfour-eyes على السيرفر. لا endpoint لتجاوز نقص الأدلة أو استثناء التسعير/السياسة.
- خطاب العرض الصادر متاح لصاحب الطلب والمراجع المصرح له عبر `GET /api/v1/offers/:id/document`. يشمل المبلغ المعتمد، والقسط، والرسوم الإدارية، وصافي الصرف، وجدول الأقساط، ومراجع الشروط والتسعير.
- صفحة **Usage** تعرض التوكنز المبلّغ عنها والمحاولات والإخفاقات والـfallback للحساب الحالي. تقدر تختار تقييم بعينه. المسار `GET /api/v1/usage/me` يقبل `runId` اختياريًا.
- Referrals/written-reason/reason-requests: Senior notes داخلية فقط؛ طلب السبب يعيد snapshot بالبند والإصدار والمصدر وتبرير المراجع، ولا يغير حالة التقييم. رد محفوظ يظل مقروءًا بعد انتهاء المهلة؛ تاريخ/مستخدم الطلب لا يأتيان من العميل.

**مدخلات التوليد في Gemini وOllama:** للسياسات: السؤال بعد إخفاء ID ذي14 رقمًا والتليفونات المصرية، ونصوص السياسات المسترجعة ومراجعها. للاستخراج: اسم pack، الصفحة/القسم، وأربعة أنواع سطور فقط: صافي الدخل، الالتزامات، بدء العمل والـbureau score. لا تُرسل الاستمارة الخام أو الأسماء أو قيم gender/religion/marital status/nationality أو صورة البطاقة. لا تدخل بيانات أشخاص في الأسئلة؛ masking ليس redaction عامًا لكل شكل PII. تحفظ النسخ الأصلية في cases الخاصة مع صلاحية owner/reviewer، ولا تُعرض مخرجات النموذج كـHTML.

تقدير Usage بيستخدم السعر القياسي المنشور بالدولار للنماذج المسجلة، ومن ضمن عدّاد إخراج Gemini توكنز التفكير المبلّغ عنها. التكلفة الفعلية من Gemini تظل غير متاحة إذا كانت خطة الفوترة غير مؤكدة. التشغيل المحلي يسجل صفر رسوم للمزوّد، وتكلفة تشغيل الجهاز خارج التقرير. استدعاءات التقييم المعزول تظهر في `providerAccounting` داخل تقرير التقييم. [أسعار Gemini الرسمية](https://aistudio.google.com/docs/pricing)

التسليم النهائي يحتاج فيديو 3–5 دقائق وتجربة تشغيل من clone جديد.

اقرأ `docs/DESIGN.md` للقرارات، `docs/EVALUATION.md` للأرقام، `docs/AI-USAGE-LOG.md` لاستخدام AI، و`FEATURES.md` للحالة.
