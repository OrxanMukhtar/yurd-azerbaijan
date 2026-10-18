# Yurd — rayon reytinqi

Azərbaycanın 66 rayonu və 11 şəhəri üçün hesab əsaslı, dəyişdirilə bilən səsvermə platforması.

Canlı sayt: https://yurd-rayon-reytinqi.allahverdi-muxtarli.workers.dev/  
GitHub: https://github.com/OrxanMukhtar/yurd-azerbaijan

## Lokal başladılma

Node.js 18+ quraşdırıldıqdan sonra bu qovluqda `npm start` işlədin. Server `http://127.0.0.1:4173` ünvanında açılır. Başqa port üçün `PORT`, hostinqdə isə `HOST=0.0.0.0` təyin edin. İlk başladılmada `data/store.json` yaranır; lokal sınaq hesabları və səslər həmin faylda saxlanılır. Bu fayl Git-ə daxil edilmir.

## Səsvermə qaydası

Hər hesabın bir aktiv səsi olur. Yeni rayon seçiləndə əvvəlki səs çıxarılır və yenisi yazılır. Eyni hesabla başqa cihazdan daxil olmaq eyni səs seçimini göstərir. Şifrələr hash-lənir, sessiyalar təhlükəsiz cookie ilə saxlanır. Qeydiyyat e-poçt və telefon təsdiqi etmir; bir insanın əlavə hesablar yaratmasını və ya parol paylaşmasını tam önləmək mümkün deyil. Parol bərpası da e-poçt/SMS yoxlaması əlavə edilənədək mövcud deyil.

## Xəritə və rayon siyahısı

`districts.json` rayonların, şəhərlərin və 14 iqtisadi rayonun Azərbaycan dilindəki adlarını saxlayır. Səs sayları ilkin olaraq sıfırdır; demo səsləri yoxdur. Sərhəd qatı geoBoundaries-in GeoJSON faylından (CC BY-SA 3.0), fon xəritəsi OpenStreetMap-dən yüklənir. Xəritə üçün internet bağlantısı lazımdır. GeoJSON sərhəd faylı 2023-cü il buraxılışındandır; yeni inzibati sərhədlər yaranarsa xəritə qatını da yeniləmək lazımdır. Sərhədlərin bir hissəsi rayon adları ilə avtomatik uyğunlaşdırılır; uyğunlaşdırılan sərhədlərin sayı xəritədə göstərilir.

## Cloudflare yayımlanması

Canlı sayt Cloudflare Workers üzərində işləyir, istifadəçi hesabları və səs məlumatları Cloudflare D1 bazasında saxlanılır. D1 yerləşmə/yurisdiksiya göstərişləri Cloudflare tərəfindən tətbiq olunur; konkret şəhər və ya data center ünvanına zəmanət vermir.

GitHub Actions `main` budağına hər push zamanı:

1. `migrations/` qovluğundakı D1 dəyişikliklərini uzaq bazaya tətbiq edir.
2. Worker API-ni və `public/` qovluğundakı saytı Cloudflare-a yayımlayır.

Yayım üçün `CLOUDFLARE_API_TOKEN` və `CLOUDFLARE_ACCOUNT_ID` GitHub Actions repository secrets kimi saxlanılır. Token repoda kod kimi saxlanılmır. Workflow-u əl ilə başlatmaq üçün GitHub reposunda **Actions → Deploy Yurd to Cloudflare → Run workflow** seçin.

Workers və D1-in pulsuz planlarında istifadə limitləri var və 24/7 əlçatanlıq SLA zəmanəti verilmir. İstifadə artdıqca Cloudflare kvotalarını və cari plan şərtlərini yoxlayın.
