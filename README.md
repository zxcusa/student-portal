# Dekanat — elektron qabul tizimi

Node.js 22+, Express 4, PostgreSQL 15+ va o‘zbekcha moslashuvchan veb interfeys. TZ faylidagi v2 SQL sxemasi asosida mavjud loyihada ishlab chiqildi. Claude artifact havolasi tashqi xizmat orqali ochilmagani uchun undagi chizma bilan alohida solishtirish bajarilmadi.

## Ishga tushirish

```powershell
npm ci
# .env.example asosida .env ni to‘ldiring
npm run migrate
npm run dev
```

Manzil: http://localhost:3000 (yoki `.env` dagi `PORT`). Admin logini/paroli `.env` orqali birinchi o‘rnatishda yaratiladi. Mavjud admin paroli migratsiya bilan almashtirilmaydi. Yangi hisoblar birinchi kirishda parolini almashtiradi. `SESSION_SECRET` kamida 24 belgi, yangi parollar 8–72 belgi. Production HTTPS bilan ishlaydi, cookie `Secure` bo‘ladi.

## Ish tartibi

1. Administrator **Bo‘limlar** orqali fakultet va unga qarashli dekanat/kafedralarni yaratadi.
2. **Guruhlar** sahifasida guruhni fakultetga, zarur bo‘lsa tyutorga biriktiradi.
3. **Foydalanuvchilar** sahifasida 6 roldan biri bilan hisob yaratadi. Talabaga guruh/kurs kiritiladi.
4. **Bo‘limlar → Biriktirish** orqali xodimni bo‘limga biriktiradi; birinchi biriktirish asosiy bo‘ladi.
5. Bo‘lim uchun **Murojaat turlari**, xodim uchun **Qabul jadvali** yaratiladi. Slotli yoki jonli navbat rejimi mavjud.
6. Talaba bo‘lim → murojaat → sana/xodim/slot → tasdiqlash orqali yoziladi. Chipta tafsilotlari **Mening navbatlarim → Batafsil** da ko‘rinadi.
7. Xodim o‘z navbatlariga javob beradi, tasdiqlaydi, qabul qilinganini yoki kelmaganini belgilaydi. Dekanat fakultet doirasida, admin barcha bo‘limlarda ishlaydi.

## Amalga oshirilgan imkoniyatlar

- PostgreSQL sessiyalari, 8 soatlik rolling cookie, har so‘rovda rol/holat tekshiruvi, parol almashtirilganda boshqa sessiyalarni yopish.
- Barcha POST so‘rovlariga CSRF. IP va login bo‘yicha 15 daqiqada 10 urinish. Katta-kichik harfga sezgir bo‘lmagan login.
- Bo‘limlar daraxti va sikldan himoya; xodimlarni biriktirish; guruhlar va tyutor biriktirish; 6 rol; foydalanuvchilarni yaratish, tahrirlash va bloklash.
- Qabul shablonlari, bazada ustma-ust jadvalga EXCLUDE, belgilangan bo‘limga FK, slot sig‘imini hisoblash va jonli navbat.
- Bronlar tranzaksiyada: talaba qatori va jadval qatori qulflanadi; unique indekslar takroriy slot va bronni rad etadi. Turli jadvallarga parallel bronlarda ham talaba limiti saqlanadi.
- 14 kunlik oyna, 30 daqiqalik yopilish, 3 faol bron, 1 soatlik bekor muddati, bayram/istisno, vaqt kesishuvi, nofaol hisob/bo‘lim/jadval va fakultet dekanatiga tegishlilik tekshiruvi. Chegaralar sozlanadi.
- Belgilangan holat o‘tishlari, majburiy rad/bekor izohi, kelajak navbatni “qabul qilindi” qilishdan himoya.
- Istisno kiritishdan oldin bekor bo‘ladigan navbatlar soni; tasdiqdan keyin tranzaksiyada bekor qilish va outbox.
- Audit jurnali, xodim/bo‘lim kesimidagi hisobot, top murojaatlar, kun-soat talabi, sig‘im va tasdiqlash vaqti; Excel eksport.
- Excel import: shablon, 1000 qatorgacha, oldindan tekshirish, qatorma-qator xatolar, tasdiqdan keyin bitta tranzaksiya. Qatorlar xatoliksiz bo‘lishi kerak. Parol bo‘sh bo‘lsa tasodifiy vaqtinchalik parol yaratiladi va faqat import natijasida CSV faylga yuklanadi. Oddiy foydalanuvchilar eksportida parollar bo‘lmaydi.
- Telegram: 10 daqiqalik bir martalik ulash tokeni, `/navbatlarim`, outbox retry, bir kun/bir soat eslatma. Bot tokeni bo‘lmasa veb funksiyalar ishlayveradi, xabar yuborilmaydi.
- Har daqiqada fon ishchisi muddati o‘tgan navbatlarni `kelmadi` qiladi, sessiyalarni tozalaydi. Outbox bir nechta nusxada `SKIP LOCKED`, bot polling yagona advisory lock bilan ishlaydi. Telegram yetkazish “at least once”: API muvaffaqiyatidan keyingi tarmoq uzilishida xabar takrorlanishi mumkin.

## Migratsiya va ma’lumotlar

`npm run migrate` tranzaksiya va advisory lock bilan ishlaydi. V1 ning raqamli va `TIME` formatidagi vaqtlarini taniydi. Dastlabki besh jadvaldagi ma’lumotlar **bazadagi** `dekanat_v1_backup` sxemasiga nusxalanadi; eski jadval `qabul_vaqti_v1` nomida va eski FK ustunlari saqlanadi. Yangi dastur ulardan foydalanmaydi. Bu nusxa serverdan tashqaridagi to‘liq backup o‘rnini bosmaydi.

Eski xodimlar “Dekanat (migratsiya)” bo‘limiga biriktiriladi. Admin haqiqiy fakultetlar, guruhlar va bo‘limlarni kiritib biriktirishlarni to‘g‘rilaydi. Migratsiya bir marta qo‘llanadi va keyingi ishga tushirishda takrorlanmaydi. `db/migrations/001_init.sql` — TZdan olingan toza v2 sxema, `003_extra.sql` — audit/outbox/sozlamalar, `004_runtime.sql` — sessiyalar va amaliy qo‘shimchalar. `002_v1_to_v2.sql` — TZdagi asl, faqat klassik v1 uchun SQL ma’lumotnoma; avtomatik migrator uni ishlatmaydi. Hozirgi gibrid bazaga uni qo‘lda ishga tushirmang.

## Telegram sozlash

`.env` ga BotFather bergan `TELEGRAM_BOT_TOKEN` va `@` siz `TELEGRAM_BOT_USERNAME` kiriting, serverni qayta boshlang. Ushbu bot uchun boshqa polling jarayoni/webhook ishlamasligi kerak. Foydalanuvchi profilidan ulaydi; ulanish faqat shaxsiy bot chatida amalga oshadi. Ishchi web jarayoni bilan birga ishlaydi, eslatmalar uchun server doim yoqilgan bo‘lishi kerak.

## Tekshirish va deploy

```powershell
npm test
npm run check
```

Integratsion testlar `.env` dagi bazada `dekanat_test_<timestamp>` nomli **alohida sxema** yaratadi va oxirida faqat shu sxemani o‘chiradi. Bazada CREATE SCHEMA huquqi kerak. Asosiy ma’lumotlarga test yozilmaydi. Windows sandbox testning bolalar jarayonini bloklasa, ruxsat bilan ishga tushirish talab qilinadi.

`render.yaml` production konfiguratsiyasini beradi; ushbu ish davomida tashqi hostingga joylashtirilmagan. `DATABASE_URL`, `ADMIN_PAROL`, SESSION_SECRET va bot sirlari repoga kiritilmaydi. Production oldidan tashqi backup, tiklash sinovi va yuk sinovini o‘tkazing.

## TZdan qolgan farqlar

- UI yangi HTML/CSS/JavaScript panel sifatida yozilgan; mavjud Handlebars SSR shablonlari saqlangan, yangi panel ulardan foydalanmaydi. TZdagi htmx o‘rnida fetch ishlatiladi.
- Ixtiyoriy TV ekran, HEMIS, fayl biriktirish, talaba nomidan yozilish va bot ichidan bron qilish kiritilmagan.
- Ustma-ust bron, rol va navbat qoidalari avtomatlashtirilgan sinovlarga ega; TZdagi barcha 32 qabul sinovi, 300 foydalanuvchilik yuk, p95 va backup tiklash hali to‘liq tasdiqlanmagan.
- Auditda IP saqlanadi; bir yillik avtomatik saqlash muddati yoqilmagan. Eski profil Telegram ustunlari bazada saqlanadi, yangi bot ulash `users.telegram_id` orqali ishlaydi.
- Foydalanuvchi, bo‘lim, murojaat turi va shablon uchun o‘chirish amallari tahrirlash oynasida. Bog‘langan tarix bo‘lsa o‘chirish rad etiladi; navbatli shablon nofaol qilinadi. Istisnolar uchun 90 kungacha sana oralig‘i mavjud. Biriktirishni olib tashlash UI hali kiritilmagan.
- Hisobotlar jadval ko‘rinishida, barcha kesimlar uchun alohida interaktiv grafiklar yo‘q. Joriy sig‘im hisobi tarixiy jadval tahrirlari versiyalarini saqlamaydi.

Claude sxemasining rasmi kelgach jadval nomlari, bog‘lanishlar va chizma bilan yakuniy solishtirish mumkin.
