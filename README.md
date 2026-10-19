# Yurd — Azərbaycanın rayonları

Yurd rayon reytinqini icma fəaliyyəti ilə birləşdirən Azərbaycan dilində MVP-dir. Rayon dəstəyi bir hesaba bir aktiv seçim kimi bağlıdır; seçimi sonradan dəyişmək mümkündür.

## Yerli işə salmaq

Node.js 20+ ilə `npm start` işlədin. Sayt `http://127.0.0.1:4173` ünvanında açılır. Yerli məlumatlar `data/store.json` faylında saxlanır; `YURD_STORE_PATH` ilə təcrid olunmuş test faylı seçilə bilər.

## Səsvermə və xəritə

Hər hesabın bir aktiv rayon səsi var. Seçim sonradan dəyişdirilə və başqa cihazda həmin hesabla görünə bilər. Şifrələr hash-lənir; mövcud qeydiyyat e-poçt/SMS təsdiqi etmir. Rayon sərhədləri geoBoundaries GeoJSON qatından, xəritənin fonu OpenStreetMap-dən yüklənir; hər iki mənbənin atribusiyası saytda göstərilir.

## İcma xüsusiyyətləri

- Mövzu sorğularında hər hesab bir dəfə iştirak edir və seçimini dəyişə bilir.
- Açıq müzakirələr sual, təklif və hekayə formatlarını, rayon etiketi və cavabları dəstəkləyir.
- “Rayonu tanı” mini oyunu cavabları serverdə yoxlayır, həftəlik ən yaxşı xal və cədvəl göstərir. Oyun xalı rayon reytinqinə təsir etmir.
- Mövzu, cavab, oyun və şikayət cəhdlərinə hesab üzrə sürət limiti tətbiq olunur. Eyni məzmuna üç fərqli hesab şikayət göndərdikdə yazı gizlənir.

## Cloudflare Workers

`worker.js` API-ni, `public/` sayt fayllarını, Cloudflare D1 isə hesab və icma məlumatlarını saxlayır. `migrations/0002_community.sql` sorğular, yazılar, cavablar, şikayətlər, sürət limitləri və oyun nəticələri üçün cədvəlləri yaradır. GitHub Actions main branch-ə push olduqda migration-ları tətbiq edib Worker-i deploy edir.

Məzmun moderasiyası bu MVP-də icma şikayətlərinin sayına əsaslanan avtomatik gizlətmədir; əl ilə baxış paneli hələ yoxdur. Hesab üçün e-poçt/SMS təsdiqi və parol bərpası da aktiv edilməyib. Cloudflare pulsuz planının kvotaları var və 24/7 SLA zəmanəti vermir.

