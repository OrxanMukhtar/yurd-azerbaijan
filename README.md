# Yurd — rayon reytinqi

Azərbaycanın 66 rayonu və 11 şəhəri üçün hesab əsaslı, dəyişdirilə bilən səsvermə MVP-si.

## Lokal başladılma

Node.js 18+ quraşdırıldıqdan sonra bu qovluqda `npm start` işlədin. Server `http://127.0.0.1:4173` ünvanında açılır. Başqa port üçün `PORT`, hostinqdə isə `HOST=0.0.0.0` təyin edin. İlk başladılmada `data/store.json` yaranır; lokal sınaq hesabları və səslər həmin faylda saxlanılır. Bu fayl Git-ə daxil edilmir.

## Səsvermə qaydası

Hər hesabın bir aktiv səsi olur. Yeni rayon seçiləndə əvvəlki səs çıxarılır və yenisi yazılır. Eyni hesabla başqa cihazdan daxil olmaq eyni səs seçimini göstərir. Şifrələr hash-lənir, sessiyalar təhlükəsiz cookie ilə saxlanır. Hazırkı qeydiyyat e-poçt və telefon təsdiqi etmir; buna görə bir insanın əlavə hesablar yaratmasını və ya parol paylaşmasını tam önləmək mümkün deyil. İctimai yayımda təsdiq və parol bərpası axını əlavə edin.

## Xəritə və rayon siyahısı

`districts.json` rayonların, şəhərlərin və 14 iqtisadi rayonun Azərbaycan dilindəki adlarını saxlayır. Səs sayları ilkin olaraq sıfırdır; demo səsləri yoxdur. Sərhəd qatı geoBoundaries-in GeoJSON faylından (CC BY-SA 3.0), fon xəritəsi OpenStreetMap-dən yüklənir. Buna görə xəritə üçün internet bağlantısı lazımdır. GeoJSON sərhəd faylı 2023-cü il buraxılışındandır; yeni inzibati sərhədlər yaranarsa xəritə qatını da yeniləmək lazımdır. Xəritənin üstündə uyğunlaşdırılan sərhədlərin sayı, altında isə mənbə və lisenziya göstərilir.

## Pulsuz Cloudflare yayımlama

Workers API-ni kənar nöqtələrdə işə salır; D1 hesab və səs məlumatlarını saxlayır. `wrangler.jsonc` və `migrations/0001_initial.sql` yayıma lazım olan quruluş fayllarıdır. D1 bazasını Şərqi Avropaya yaxın `eeur` yerləşmə göstərişi ilə, məlumatları Aİ yurisdiksiyasında saxlamaq üçün `eu` məhdudiyyəti ilə yaratmaq nəzərdə tutulub. Yer seçimi göstərişdir; konkret şəhər və ya data center zəmanəti verilmir.

Yayım addımları:

1. GitHub-da `yurd-azerbaijan` adlı şəxsi depo yaradın və `outputs` qovluğundakı faylları ora yükləyin.
2. Cloudflare hesabında Workers & Pages bölməsindən GitHub deposunu qoşun. Alternativ olaraq Wrangler CLI ilə giriş edin.
3. D1 bazasını `yurd-votes` adı ilə `eeur` yerləşmə göstərişi və `eu` yurisdiksiyası ilə yaradın. Yaradılan ID-ni `wrangler.jsonc` içindəki `CREATE_D1_DATABASE_FIRST` yerinə yazın.
4. `npx wrangler d1 migrations apply yurd-votes --remote` və sonra `npm run deploy` işlədin.

Cloudflare hesabına giriş, GitHub icazəsi, təsdiq və xidmət şərtləri istifadəçinin hesabından tamamlana bilər. Workers və D1 pulsuz planının kvotaları var; kvotalar aşılarsa sorğular dayana bilər. Xidmət boş qalanda Render-in pulsuz planı kimi yatmır, amma pulsuz plan 24/7 əlçatanlığa SLA zəmanəti vermir. İctimai istismara verməzdən əvvəl kvotaları və cari şərtləri yoxlayın.

Cloudflare versiyasında istifadəçi adı, salted şifrə hash-i, sessiya tokeninin hash-i və aktiv rayon səsi saxlanılır. E-poçt/SMS təsdiqi olmadığına görə unudulmuş parolu bərpa etmək mümkün deyil; ictimai buraxılışda təsdiq və bərpa mexanizmi əlavə edin.
