# Credit Copilot

Synthetic personal-loan underwriting workspace: React/Vite → NestJS REST/OpenAPI → Application → pure Domain, with PostgreSQL/pgvector, TypeORM and Mastra adapters. كل البيانات تدريبية؛ التوصية الآلية تحتاج قرارًا بشريًا قبل الإصدار.

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

seed يفهرس السياسات السبع فقط؛ تكراره يرجع skipped. حسابات Demo تستخدم كلمة المرور المحلية المحددة بطول12–256 حرفًا: `loan-officer`، `credit-officer` بحد250,000، `senior-credit-officer` بحد500,000 و`head-credit` بحد1,000,000. إعادة seed:users تحدث كلمات المرور وتلغي الجلسات. حسابات fixture CLI لا تصلح للدخول.

## 5-Minute Demo Path

1. سجّل دخول loan-officer. من Knowledge راجع المصادر؛ الرفع يحتاج canIngest وهو متاح لحساب head-credit.
2. اسأل: `What is the maximum debt burden ratio in CP-2024?` ثم CP-2025. راجع50%/45% والمصدر والتاريخ.
3. اسأل عن crypto-backed loans: يجب رفض السؤال لغياب المصدر. أسئلة التعارض تعرض اقتباسات السياسة والمنتج/التعميم، بمراجع زمنية صريحة.
4. جرّب Calculate: مبلغ300000، دخل30000، التزامات4000،60 شهرًا؛2025-04-03 يعطي EMI8630.39 وmaximum330000. غيّر التاريخ إلى2024-12-01 فيصبح maximum382000. الحساب وحده ليس موافقة.
5. Add application → APP-001 → Run assessment. Strict افتراضي ونقص البطاقة يؤدي لإحالة CP-8/PS-7. نزّل الأصل وراجع Summary/Rules & sources/Workflow؛ المعروض مراحل محفوظة وليس SSE.
6. لتجربة مسار الاعتماد، فعّل ALLOW_DEMO_MODE=true محليًا وأعد تشغيل API ثم اختار Demo صراحة. APP-001 يعطي توصية pending_approval؛ افتراض وجود البطاقة وverified=false واضحان. APP-004 يُحال للاحتيال بدون استدعاء نموذج. APP-002/003/005 تظل إحالات لنقص إثبات probation؛ لا نفترض اكتماله.
7. سجّل دخول credit-officer وحاول اعتماد توصية300,000: السيرفر يرفض تجاوز250,000. مستخدم Senior مستقل يسجل التبرير والاعتماد ثم يصدر العرض بتاريخ صرف مناسب. العرض يظل Demo، وليس إثبات مستندات مكتملة أو خطاب PDF.
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
```

integration وcore:offline وe2e تستخدم قاعدة تنتهي بـ_test؛ شغّلها بالتتابع. لو غير موجودة، أنشئها مرة عبر `docker compose exec -T db psql -U copilot -d postgres -c "CREATE DATABASE credit_copilot_test"`. e2e تفرغ حسابات/طلبات قاعدة الاختبار، وتشغّل API4304 وVite5174. الصور/traces خارج Git. offline لا يقيس جودة semantic/LLM.

`pnpm evaluate` يشغّل15 حالة فعلية عبر Gemini في قاعدة منفصلة تنتهي بـ_eval، وينشئها إن كانت صلاحية المستخدم تسمح. لا يغيّر بيانات الطلبات في قاعدة التطبيق. يقرأ cache موثوقًا لمتجهات السياسات المطابقة للنص/model/dimensions، بينما embeddings الأسئلة والاستدعاءات التوليدية live. يحفظ كل تشغيل، حتى الفاشل، في `artifacts/evaluation/`، ويخرج بكود فشل إذا لم تمر البوابة. يلزم مفتاح وquota؛ هذا الأمر يستهلكها.

الحالات الذهبية في `data/evaluation/cases.json` والتقارير الفعلية في `data/evaluation/results/`. الـvector baseline عدّى 15/15 وhit@5 كان 4/4 على الأسئلة القابلة للإجابة. شغّل `pnpm evaluate --vector` و`pnpm evaluate --hybrid` للمقارنة. البحث الافتراضي يدمج BM25 وpgvector بـRRF، وQ&A يطبّق عتبة الـcosine على الأدلة. التفاصيل وتقارير الفشل في `docs/EVALUATION.md`. `pnpm evaluate:smoke` يحتفظ بفحص الـvector القديم لخمس حالات، و`pnpm evaluate:offline` يشغّل regression tests بسيطة من غير DB.

## Configuration

كل المتغيرات الحالية في `.env.example`. أعد تشغيل API عند تغييرها؛ الأسرار تبقى على السيرفر.

| Variable | Default / use |
|---|---|
| DATABASE_URL | PostgreSQL local54329/credit_copilot؛ migrations عبر CLI، synchronize=false |
| EVALUATION_DATABASE_URL | اختياري؛ إن غاب يُشتق اسم _eval من DATABASE_URL |
| PORT / WEB_ORIGIN | 3000 / http://localhost:5173؛ origin لازم يطابق عنوان المتصفح |
| GEMINI_API_KEY | سر محلي؛ غير مطلوب لاختبارات fake/offline |
| LLM_PROVIDER | gemini فقط حاليًا؛ fake يُحقن في الاختبارات، وليس اختيار production |
| GENERATION_MODEL | gemini-3.5-flash-lite؛ اسم النموذج المسجل في القياس |
| EMBEDDING_MODEL / EMBEDDING_DIMENSIONS | gemini-embedding-001 /768؛ تغييرهما يحتاج إعادة فهرسة وbaseline جديد |
| RETRIEVAL_STRATEGY | hybrid افتراضيًا؛ vector لتشغيل البحث الدلالي وحده |
| RETRIEVAL_MIN_SIMILARITY | 0.65؛ عتبة cosine للأدلة في الوضعين |
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

- Knowledge: عرض السياسات، multipart `files` لدفعات1–20 ونتيجة كل ملف. الـmanifest يقبل السياسات السبع المعروفة فقط.
- Applications: multipart `file` أو اختيار fixture، list/read/download، assessments. يقبل الـPDF packs الخمسة المعروفة بالـhash فقط؛ بيانات العميل لا تدخل Knowledge Base.
- Reviews/decisions/offers: الصلاحيات والمبلغ والنسخة وfour-eyes على السيرفر. لا endpoint لتجاوز نقص الأدلة أو استثناء التسعير/السياسة.
- Referrals/written-reason/reason-requests: Senior notes داخلية فقط؛ طلب السبب يعيد snapshot بالبند والإصدار والمصدر وتبرير المراجع، ولا يغير حالة التقييم. رد محفوظ يظل مقروءًا بعد انتهاء المهلة؛ تاريخ/مستخدم الطلب لا يأتيان من العميل.

**ما يُرسل إلى Gemini:** للسياسات: السؤال بعد إخفاء ID ذي14 رقمًا والتليفونات المصرية، ونصوص السياسات المسترجعة ومراجعها. للاستخراج: اسم pack، الصفحة/القسم، وأربعة أنواع سطور فقط: صافي الدخل، الالتزامات، بدء العمل والـbureau score. لا تُرسل الاستمارة الخام أو الأسماء أو قيم gender/religion/marital status/nationality أو صورة البطاقة. لا تدخل بيانات أشخاص في الأسئلة؛ masking ليس redaction عامًا لكل شكل PII. تحفظ النسخ الأصلية في cases الخاصة مع صلاحية owner/reviewer، ولا تُعرض مخرجات النموذج كـHTML.

البوابة الوظيفية اجتازت العينة المحددة؛ هذا ليس تعميمًا لجودة RAG. تكلفة الفاتورة وتوكنات embedding/retries غير متاحة من الـports وتُسجل unknown. كل الـstretch goals لاحقًا حسب FEATURES.md. التسليم النهائي ما زال يحتاج فيديو3–5 دقائق ومراجعة clean-clone؛ تاريخ Git الفعلي يغطي3 أيام Cairo فقط، وليس4، ولن نصطنع تاريخ commits. لا توجد رسالة تقديم أو نشر تلقائي.

اقرأ `docs/DESIGN.md` للقرارات، `docs/EVALUATION.md` للأرقام، `docs/AI-USAGE-LOG.md` لاستخدام AI، و`FEATURES.md` للحالة.
