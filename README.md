# RUTH ISTANBUL Manuel Canlı Destek Paneli

Bu paket mevcut sitedeki sohbet balonunu koruyup ChatGPT API yerine manuel canlı destek paneline bağlar. Panelde ana sayfa, Canlı Destek ve CRM modülleri vardır.

## İçerik

- `server.js`: Render'da çalışacak backend.
- `public/admin/`: iPhone ana ekrana eklenebilen PWA panel.
- `ruth-ikas-widget-manuel-canli-destek.html`: ikas özel kod alanına eklenecek müşteri sohbet balonu.
- `sql/supabase-schema.sql`: Supabase tabloları.
- `.env.example`: Render ortam değişkenleri örneği.

## Kurulum

1. Supabase'de yeni proje aç.
2. Supabase SQL Editor içinde `sql/supabase-schema.sql` dosyasını çalıştır.
3. Render'da bu klasörü Node servisi olarak deploy et.
4. Render ortam değişkenlerini `.env.example` dosyasına göre gir.
5. Push için yerelde veya Render shell'de çalıştır:

```bash
npm run vapid
```

Çıkan `VAPID_PUBLIC_KEY` ve `VAPID_PRIVATE_KEY` değerlerini Render ortam değişkenlerine ekle.

## Panel Kullanımı

- Panel adresi: `https://SENIN-RENDER-ADRESIN/admin/`
- iPhone'da Safari ile paneli aç, paylaş menüsünden **Ana Ekrana Ekle** seç.
- Giriş yaptıktan sonra ana sayfada iki modül görünür:
  - **Canlı Destek**: müşteri mesajları ayrı konuşmalar halinde.
  - **CRM**: müşteri profiline not ve tarih/saatli hatırlatma.

## ikas Sohbet Balonu

`ruth-ikas-widget-manuel-canli-destek.html` içindeki şu adresleri kendi Render adresinle değiştir:

```js
apiUrl: "https://SENIN-RENDER-ADRESIN/api/chat",
updatesUrl: "https://SENIN-RENDER-ADRESIN/api/chat/updates",
```

Sonra dosyadaki tüm kodu ikas özel kod / footer script / Custom HTML alanına ekle.

## Notlar

- ChatGPT/OpenAI çağrısı yoktur.
- Her müşteri tarayıcıda saklanan ayrı `sessionId` ile ayrılır.
- Aynı müşteri aynı konuşmada kalır, farklı müşteriler ayrı profil olur.
- Fotoğraflar v1'de mesaj içinde data URL olarak saklanır; çok yüksek trafikte Supabase Storage'a taşınabilir.
- İlk sürüm tek panel hesabıyla çalışır; kullanıcı adı/şifre Render environment üzerinden yönetilir.
