# OllieProxy

Um proxy compatível com a API da OpenAI que traduz requisições para o backend da OllieChat. Permite usar qualquer cliente da API OpenAI (SDKs, ferramentas, IDEs) apontando para modelos hospedados na OllieChat.

## Recursos

- **Compatível com OpenAI**: endpoints `POST /v1/chat/completions` e `GET /v1/models`
- **Streaming SSE**: suporte completo a `stream: true` com transformação de chunks
- **Thinking / reasoning**: níveis de raciocínio via sufixo no nome do modelo ou via `reasoning_effort`
- **Tool calls**: repassa `tools` e `tool_choice` para o upstream e acumula tool calls no modo não-streaming
- **Parsing de `[[think]]`**: blocos de raciocínio embutidos no `content` são extraídos para `reasoning_content`
- **Resiliência**: aborta o upstream quando o cliente desconecta, timeout configurável, limite de corpo
- **Health checks**: `GET /health` e `GET /v1/health`
- **Redação reversível de PII (Layer 1)**: dados identificáveis nas mensagens de entrada são substituídos por tokens opacos antes de chegar ao upstream e restaurados na resposta de volta ao cliente — ativo por padrão, desligável via `REDACT_PII=0`

## Requisitos

- Node.js >= 22

## Instalação

```bash
npm install
```

## Uso

### Desenvolvimento

```bash
npm run dev
```

### Produção

```bash
npm run build
npm start
```

O servidor sobe por padrão em `http://0.0.0.0:3000`.

### Docker

A imagem multi-stage compila o TypeScript, poda dependências de dev e roda como usuário não-root (`app`) em `node:22-alpine`.

```bash
# Build
docker build -t ollieproxy .

# Run (redação de PII já vem ativa por padrão)
docker run -d --name ollieproxy -p 3000:3000 ollieproxy

# Desativar a redação, trocar upstream, etc. — sobrescreva as envs
docker run -d --name ollieproxy -p 3000:3000 \
  -e REDACT_PII=0 \
  -e UPSTREAM_URL=https://meu-backend.example.com \
  ollieproxy
```

A imagem expõe a porta `3000` e aceita todas as variáveis listadas abaixo.

## Configuração

Todas as configurações são via variáveis de ambiente:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta de escuta |
| `HOST` | `0.0.0.0` | Host de escuta |
| `UPSTREAM_URL` | `https://olliechat-lac.vercel.app/` | URL base do backend OllieChat |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Timeout da requisição ao upstream (ms) |
| `BODY_LIMIT_BYTES` | `4194304` | Limite de corpo da requisição (bytes) |
| `REDACT_PII` | `1` | Ativa a redação reversível de PII (`1`/`true`/`on` para ligar, `0`/`false`/`off` para desligar). Ativa por padrão |
| `REDACT_CATEGORIES` | *(padrão)* | Lista CSV de categorias quando `REDACT_PII=1`, ou `all` para todas. Default = sensíveis + baixo falso-positivo; `all` adiciona as opt-in de FP mais alto |
| `AUTH_ENABLED` | `0` | Exige API key em `/v1/*` (`/health` continua liberado). OFF por padrão — crie chaves antes de ligar |
| `KEYS_FILE` | `./data/keys.json` | Arquivo onde as chaves (hasheadas) são guardadas |
| `DEFAULT_RPM` | `60` | Limite padrão de requisições por minuto por chave. Cada chave pode sobrescrever via `--rpm` |
| `MODELS_CACHE_TTL_MS` | `300000` | TTL do cache da lista de modelos do upstream (ms) |

## Endpoints

### `POST /v1/chat/completions`

Cria uma conclusão de chat. Compatível com o formato OpenAI.

**Parâmetros suportados:** `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `tools`, `tool_choice`, `reasoning_effort`, `stream_options`, `user`, `presence_penalty`, `frequency_penalty`.

**Limitações:**

- `n > 1` retorna erro 400 (não suportado pelo proxy).
- `logprobs` não é suportado.

#### Exemplo (não-streaming)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-fable-5",
    "messages": [{"role": "user", "content": "Olá"}]
  }'
```

#### Exemplo (streaming)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-fable-5",
    "stream": true,
    "messages": [{"role": "user", "content": "Olá"}]
  }'
```

### `GET /v1/models`

Lista os modelos disponíveis, incluindo as variantes com nível de thinking.

### `GET /v1/models/:model`

Retorna os detalhes de um modelo específico.

### `GET /health` e `GET /v1/health`

Retorna `{"status":"ok"}`.

## Redação reversível de PII (Layer 1)

Quando `REDACT_PII=1` (ativo por padrão), o proxy inspeciona as mensagens de entrada em busca de dados identificáveis e os substitui por tokens opacos (`<<PII_EMAIL_1>>`, `<<PII_PHONE_1>>`, …) **antes** de enviá-las ao upstream. Na resposta (streaming ou não), os tokens são restaurados para os valores originais antes de chegarem ao cliente. Para desativar, use `REDACT_PII=0`.

O objetivo é proteger PII mesmo contra um upstream malicioso, sem degradar a resposta do modelo: o mesmo valor sempre mapeia para o mesmo token dentro de uma requisição, então o modelo continua conseguindo raciocinar sobre "o mesmo email aparecendo duas vezes".

Categorias suportadas (configuráveis via `REDACT_CATEGORIES`):

**No padrão** (ativadas com `REDACT_PII=1` sem `REDACT_CATEGORIES`) — alta sensibilidade, baixo falso-positivo:

| Categoria | Detecta | Validação |
| --- | --- | --- |
| `email` | endereços `user@host.tld` | — |
| `phone` | números nacionais/internacionais com DDD, `+`, espaços, `-`, `.` | mínimo de 8 dígitos |
| `cpf` | 11 dígitos, com ou sem formatação | dígitos verificadores |
| `cnpj` | 14 dígitos, com ou sem formatação | dígitos verificadores |
| `apikey` | `sk-…`, `sk-ant-…`, `ghp_…`, `xox…`, `AIza…`, hex 32+, alnum 40+ | — |
| `card` | 13–19 dígitos agrupados | checksum de Luhn |
| `dburl` | connection strings com senha (`postgres://user:pass@host/db`) | requer senha embutida |
| `jwt` | três segmentos base64url (`ey…`) | — |
| `privatekey` | blocos PEM `-----BEGIN … PRIVATE KEY-----` | — |
| `aws` | access key id (`AKIA…` etc.) e secret access key (40 chars) | heurística de secret |

**Opt-in** (risco de falso-positivo em prosa comum — use `REDACT_CATEGORIES=all` ou liste explicitamente):

| Categoria | Detecta | Validação |
| --- | --- | --- |
| `ip` | IPv4 e IPv6 (incl. `::` comprimido) | octetos 0–255, sem zero à esquerda |
| `mac` | endereços Ethernet `aa:bb:cc:dd:ee:ff` | — |
| `cep` | CEP brasileiro `XXXXX-XXX` | 8 dígitos |
| `pis` | PIS/NIT brasileiro (11 dígitos) | dígito verificador |
| `ssn` | SSN americano `XXX-XX-XXXX` | regras da SSA (área/grupo/serial) |
| `token` | `Bearer <v>`, `token=`, `api_key=`, `password=` etc. | redige só o valor após a palavra-chave |

A correspondência token ↔ original vive apenas em memória pelo tempo de vida da requisição e nunca é persistida ou logada. No modo streaming, a restauração usa um buffer de lookahead para recompor tokens que cheguem splitados entre chunks.

```bash
# Padrão (sensíveis + baixo FP) — já ativo sem configurar nada
npm start

# Tudo, inclusive as opt-in de FP mais alto
REDACT_PII=1 REDACT_CATEGORIES=all npm start

# Seleção explícita
REDACT_PII=1 REDACT_CATEGORIES=email,phone,dburl,jwt npm start

# Desativar
REDACT_PII=0 npm start
```

## API keys e rate limit

O proxy pode exigir uma API key em todos os endpoints `/v1/*` (`/health` e `/v1/health` ficam liberados para probes). As chaves são guardadas apenas como hash SHA-256 num arquivo JSON, e cada chave tem seu próprio limite de requisições por minuto (RPM).

### Criar / listar / revogar chaves (CLI)

> Os scripts `key:*` rodam o CLI compilado em `dist/`, então rode `npm run build` antes de usá-los pela primeira vez ou após mudanças no código.

```bash
# Cria uma chave com label e RPM próprio; imprime o plaintext UMA vez
npm run key:create -- --label=acme-client --rpm=30
# Com expiração (sufixo d/h/m)
npm run key:create -- --label=temp --rpm=100 --expires-in=7d

# Lista todas (id, status, rpm, expiração, label)
npm run key:list

# Revoga pelo id (efeito imediato, sem restart)
npm run key:revoke -- <id>

# Remove definitivamente pelo id (hard-delete, irreversível)
npm run key:remove -- <id>
```

Em produção, rode o CLI dentro do container apontando para o diretório de dados. No Railway, anexe um **Volume** ao path `/app/data` e rode:

```bash
# Railway: execute um command efêmero no serviço
node dist/keys/cli.js create --label=ci --rpm=60
```

Em Docker local, monte um volume em `/app/data`:

```bash
docker run --rm -v ollieproxy-data:/app/data ollieproxy node dist/keys/cli.js create --label=ci --rpm=60
```

### Ativar a exigência de key

```bash
AUTH_ENABLED=1 DEFAULT_RPM=60 npm start
```

Clientes enviam a key no header `Authorization: Bearer op_…`. Sem key → `401`; acima do RPM → `429` com `Retry-After` e headers `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`.

### Detalhes

- As chaves são armazenadas somente como hash, então um `keys.json` vazado não expõe credenciais usáveis. O plaintext é mostrado apenas no momento da criação.
- A revogação/criação/remoção de chaves via CLI surte efeito sem reiniciar o serviço: o proxy recarrega o arquivo quando seu mtime muda.
- `revoke` desativa a chave suavemente (verificação falha, mas o registro continua no arquivo e aparece em `list`). `remove` apaga o registro do `keys.json` definitivamente — irreversível.
- O rate limit é por chave, em janela fixa de 60s, em memória (reseta no restart). Para anti-abuso isso é suficiente: nenhum atacante excede `rpm` de forma sustentada.

## Níveis de Thinking

Os níveis de raciocínio podem ser definidos de duas formas (com precedência para `reasoning_effort` explícito):

1. **Sufixo no nome do modelo**: `claude-fable-5-max` → thinking `max`
2. **Campo `reasoning_effort`** no corpo da requisição: `"reasoning_effort": "high"`

| Nível | Sufixo do modelo | Valor enviado ao upstream |
| --- | --- | --- |
| `off` | (nenhum) | (omitido) |
| `low` | `-low` | `low` |
| `medium` | `-medium` | `medium` |
| `high` | `-high` | `high` |
| `max` | `-max` | `xhigh` |

## Modelos

Os modelos são obtidos dinamicamente do upstream em `GET {upstream}/v1/models`. Cada modelo base é exposto também com sufixos de nível de thinking: `-low`, `-medium`, `-high`, `-max`.

O proxy cacheia a lista por `MODELS_CACHE_TTL_MS` (default 5 minutos). Em caso de falha, o cache expirado é servido; se não houver cache, retorna lista vazia.

## Estrutura do projeto

```
src/
  index.ts        # Entry point + graceful shutdown
  server.ts       # Instância Fastify, CORS, rotas, health checks, auth
  config.ts       # Configuração via env
  schemas.ts      # Validação Zod das requisições
  routes/
    chat.ts       # /v1/chat/completions (streaming e não-streaming)
    models.ts     # /v1/models
  utils/
    model.ts      # Parse de sufixo de thinking + mapeamento upstream
    upstream-models.ts  # Fetch + cache da lista de modelos do upstream
    stream.ts     # ThinkParser incremental + StreamTransformer (+ restauração PII)
    redact.ts     # Layer 1: Redactor/Restorer + padrões e validadores (CPF/CNPJ/Luhn)
  keys/
    store.ts      # JSON store de API keys (hash SHA-256, write atômico)
    auth.ts       # Verificação de bearer + reload por mtime
    ratelimit.ts  # Rate limiter in-memory por chave (janela fixa de RPM)
    plugin.ts     # Hook preHandler: auth + rate limit no Fastify
    cli.ts        # CLI key:create / key:list / key:revoke / key:remove
```

## Scripts

| Script | Descrição |
| --- | --- |
| `npm run dev` | Modo desenvolvimento com watch (`tsx watch`) |
| `npm run build` | Compila TypeScript para `dist/` |
| `npm start` | Executa o build de produção |
| `npm run key:create` | Cria uma API key (`--label`, `--rpm`, `--expires-in`) |
| `npm run key:list` | Lista todas as chaves (id, status, rpm, expiração, label) |
| `npm run key:revoke` | Revoga uma chave pelo id (soft, reversível criando de novo) |
| `npm run key:remove` | Remove uma chave pelo id do `keys.json` (hard-delete, irreversível) |

## CI

O workflow em `.github/workflows/ci.yml` roda a cada push/PR no `main`:

- `npm ci` + `npm run build` (typecheck + compilação)
- Smoke test do servidor nativo contra `GET /health`
- Build da imagem Docker (com cache GHA)
- Smoke test do container contra `GET /health`
