# Cloud Proxy Kurulumu

## Seçenek 1: Cloudflare Workers (Önerilen - Ücretsiz)

### Adım 1: Cloudflare hesabı aç
1. https://dash.cloudflare.com/sign-up adresine git
2. Email ile kayıt ol (ücretsiz)

### Adım 2: Worker oluştur
1. Dashboard'da "Workers & Pages" tıkla
2. "Create Worker" tıkla
3. Aşağıdaki kodu yapıştır ve "Deploy" tıkla

```javascript
// Cloudflare Worker - Binance WebSocket Proxy
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // WebSocket upgrade isteği mi?
    if (request.headers.get('Upgrade') === 'websocket') {
      const streams = url.searchParams.get('streams') || '';
      const binanceUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
      
      // Binance'e bağlan
      const binanceResponse = await fetch(binanceUrl, {
        headers: { 'Upgrade': 'websocket' }
      });
      
      return binanceResponse;
    }
    
    // REST API proxy
    if (url.pathname.startsWith('/api/')) {
      const binanceUrl = 'https://api.binance.com' + url.pathname.replace('/api', '') + url.search;
      return fetch(binanceUrl);
    }
    
    return new Response('Binance Proxy Active', { status: 200 });
  }
}
```

### Adım 3: Worker URL'ini kopyala
Deploy sonrası `https://your-worker.username.workers.dev` şeklinde URL alacaksın.

### Adım 4: mockMarket.ts'yi güncelle
```typescript
const BINANCE_WS_BASE = 'wss://your-worker.username.workers.dev';
```

---

## Seçenek 2: Hazır Proxy Servisler

Bazı ücretsiz WebSocket proxy servisleri:
- `wss://ws-proxy.example.com` (örnek)

---

## Seçenek 3: Alternatif Binance Endpoint'leri

Bazı bölgelerde farklı endpoint'ler çalışabilir:
- `wss://stream.binance.com:443/stream` (443 portu)
- `wss://fstream.binance.com:9443/stream` (futures)
