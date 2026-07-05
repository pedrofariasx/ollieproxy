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
| `UPSTREAM_URL` | `https://olliechat-sw02.onrender.com` | URL base do backend OllieChat |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Timeout da requisição ao upstream (ms) |
| `BODY_LIMIT_BYTES` | `4194304` | Limite de corpo da requisição (bytes) |
| `REDACT_PII` | `1` | Ativa a redação reversível de PII (`1`/`true`/`on` para ligar, `0`/`false`/`off` para desligar). Ativa por padrão |
| `REDACT_CATEGORIES` | *(padrão)* | Lista CSV de categorias quando `REDACT_PII=1`, ou `all` para todas. Default = sensíveis + baixo falso-positivo; `all` adiciona as opt-in de FP mais alto |

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

Os modelos base disponíveis (cada um exposto também com sufixos `-low`, `-medium`, `-high`, `-max`):

- `claude-fable-5` (anthropic)
- `claude-sonnet-5` (anthropic)
- `claude-opus-4-8` (anthropic)
- `glm-5.2` (zhipu)
- `glm-5.2-fast` (zhipu)
- `deepseek-v4-pro` (deepseek)
- `kimi-k2.7-code` (moonshot)
- `minimax-m3` (minimax)
- `qwen-3.7-plus` (alibaba)

## Estrutura do projeto

```
src/
  index.ts        # Entry point + graceful shutdown
  server.ts       # Instância Fastify, CORS, rotas, health checks
  config.ts       # Configuração via env
  schemas.ts      # Validação Zod das requisições
  routes/
    chat.ts       # /v1/chat/completions (streaming e não-streaming)
    models.ts     # /v1/models
  utils/
    model.ts      # Parse de sufixo de thinking + mapeamento upstream
    stream.ts     # ThinkParser incremental + StreamTransformer (+ restauração PII)
    redact.ts     # Layer 1: Redactor/Restorer + padrões e validadores (CPF/CNPJ/Luhn)
```

## Scripts

| Script | Descrição |
| --- | --- |
| `npm run dev` | Modo desenvolvimento com watch (`tsx watch`) |
| `npm run build` | Compila TypeScript para `dist/` |
| `npm start` | Executa o build de produção |

## CI

O workflow em `.github/workflows/ci.yml` roda a cada push/PR no `main`:

- `npm ci` + `npm run build` (typecheck + compilação)
- Smoke test do servidor nativo contra `GET /health`
- Build da imagem Docker (com cache GHA)
- Smoke test do container contra `GET /health`
