# Mentor360 Backend

## Analytics / CORS

A API utiliza uma política de CORS baseada em allowlist.

- As origens de produção são definidas em `CORS_ORIGINS` (lista separada por vírgula).
- Ambientes de preview do Render são aceitos automaticamente quando a origem começa com `https://`, termina com `.onrender.com` e contém `-pr-` no hostname.
- Outras origens podem ser adicionadas via `CORS_EXTRA_ORIGINS` (lista separada por vírgula).

As requisições de preflight recebem os cabeçalhos `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` e `Access-Control-Allow-Headers`; não enviamos credenciais.

O endpoint `GET /health` está público e responde `{"status":"ok"}`.
