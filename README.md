# StreamBR Finder — Stremio Addon

Addon que busca streams de múltiplas fontes para filmes e séries.

## Instalação

```bash
npm install
npm start
```

Acesse `http://127.0.0.1:7000` e clique em Instalar.

Se instalar manualmente no Stremio Desktop, use:

```text
http://127.0.0.1:7000/manifest.json
```

Evite `https://localhost/manifest.json`: esse endereco nao tem a porta do servidor local.

## Configuração opcional

```bash
MAX_STREAMS=80
MAX_STREAMS_PER_QUALITY=12
STREAM_SORT=quality # quality ou seeders
SOURCE_TIMEOUT_MS=9000
METADATA_TIMEOUT_MS=5000
OMDB_API_KEYS=sua_chave_1,sua_chave_2
ENABLED_PROVIDERS=YTS,TPB,1337x
DISABLED_PROVIDERS=RuTrk,Nyaa
EXCLUDE_QUALITIES=360p,480p
```
