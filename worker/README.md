# Cloudflare Worker プロキシ

デプロイ方法:
```bash
cd worker
wrangler deploy
```

シークレットの設定（初回のみ）:
```bash
wrangler secret put GOOGLE_BOOKS_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

ダッシュボード:
https://book-finder-proxy.umeallux.workers.dev/logs-ui
