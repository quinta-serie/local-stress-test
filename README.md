# local-stress-test

## Description

Framework de stress test baseado em [K6](https://k6.io/open-source/) que executa inteiramente via Docker — sem necessidade de instalar o K6 localmente.

O script lê um arquivo **JSON de template** que descreve a requisição HTTP e o formato do payload. A cada iteração de VU, o engine de templates resolve placeholders de funções (`$randomNumber`, `$randomDate`, etc.) para gerar payloads aleatórios e únicos, simulando diferentes cenários de carga.

Principais funcionalidades:
- Geração dinâmica de payloads com funções built-in (números, strings, datas, UUIDs, etc.)
- Suporte a arrays de tamanho aleatório com `$type: "array"`
- Referência entre campos com `$totalItems(arrayId)` (ex: campo `total_records` que conta o array `data`)
- Leitura de variáveis de ambiente nos templates via `#varName` (ex: `$toNumber(#otherVar)`)
- Funções customizadas extensíveis via arquivo `custom_functions.js` montado em runtime
- Suporte a múltiplos templates em uma única execução (round-robin por VU)
- Opções do K6 (VUs, duration, stages) configuráveis no próprio template ou via CLI

---

## Dependencies

| Dependência | Versão | Observação |
|-------------|--------|------------|
| [Docker](https://www.docker.com/get-started) | 20.10+ | Única dependência local necessária |
| [grafana/k6](https://hub.docker.com/r/grafana/k6) | `latest` | Baixado automaticamente no `docker build` |

> **Não é necessário instalar o K6 localmente.** Toda a execução ocorre dentro do container Docker.

---

## Install and Config

### 1. Clone o repositório

```bash
git clone <repo-url>
cd local-stress-test
```

### 2. Build da imagem Docker

```bash
docker build -t local-stress-test .
```

Isso empacota o `stress_test.js` e o `custom_functions.js` padrão dentro da imagem. Os arquivos de template são sempre montados em runtime via `-v`.

### 3. Crie seu template de payload

Copie o exemplo e adapte para o seu cenário:

```bash
cp examples/template.json meu-template.json
```

Edite `meu-template.json` com a URL da sua API, os headers necessários e o formato do payload. Veja a seção [Examples](#examples) para referência completa.

### 4. (Opcional) Personalize as funções customizadas

Edite o `custom_functions.js` local antes de rodar — ou use o arquivo da imagem como base. O arquivo é montado em runtime e substitui o que está na imagem:

```bash
# Montar seu próprio custom_functions.js:
-v $(pwd)/custom_functions.js:/app/custom_functions.js
```

---

## How to Run

### Template único (caminho padrão `/app/template.json`)

```bash
docker run --rm \
  -v $(pwd)/meu-template.json:/app/template.json \
  -v $(pwd)/custom_functions.js:/app/custom_functions.js \
  local-stress-test run /app/stress_test.js \
  -e otherVar=100 \
  --vus 10 --duration 30s
```

### Múltiplos templates (round-robin por VU)

```bash
docker run --rm \
  -v $(pwd)/templates:/app/templates \
  -v $(pwd)/custom_functions.js:/app/custom_functions.js \
  local-stress-test run /app/stress_test.js \
  -e TEMPLATES=/app/templates/t1.json,/app/templates/t2.json \
  -e otherVar=100 \
  --vus 10 --duration 30s
```

> Com múltiplos templates, VU 1 usa `templates[0]`, VU 2 usa `templates[1]`, e assim por diante. Configure `--vus` com pelo menos o número de templates para garantir que todos sejam exercitados.

### Variáveis de ambiente disponíveis

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `TEMPLATES` | `/app/template.json` | Caminhos dos templates, separados por vírgula |
| `SLEEP_SECONDS` | `0` | Pausa em segundos entre iterações por VU |
| Qualquer outra | — | Acessível nos templates via `$toNumber(#varName)` / `$toString(#varName)` |

### Opções K6 no template vs CLI

As opções definidas em `k6_options` no template são usadas como padrão. Flags passadas na CLI **sempre sobrescrevem** o template:

```json
"k6_options": {
  "vus": 10,
  "duration": "30s"
}
```

```bash
# Sobrescreve o template: roda com 50 VUs por 1 minuto
--vus 50 --duration 1m
```

---

## How to Test

### Verificar sintaxe do script e opções sem fazer requisições

```bash
docker run --rm \
  -v $(pwd)/examples/template.json:/app/template.json \
  local-stress-test inspect /app/stress_test.js \
  -e otherVar=100
```

O output mostra as opções K6 resolvidas (incluindo `vus` e `duration` do template). Se houver erros de sintaxe no script ou no JSON, eles aparecem aqui.

### Teste rápido com 1 VU e 1 iteração

```bash
docker run --rm \
  -v $(pwd)/examples/template.json:/app/template.json \
  -v $(pwd)/custom_functions.js:/app/custom_functions.js \
  local-stress-test run /app/stress_test.js \
  -e otherVar=100 \
  --vus 1 --iterations 1
```

### Teste de carga com ramping (stages)

Defina stages diretamente no template ou via `--stage` na CLI:

```json
"k6_options": {
  "stages": [
    { "duration": "30s", "target": 10 },
    { "duration": "1m",  "target": 50 },
    { "duration": "30s", "target": 0  }
  ]
}
```

### Métricas customizadas

O script registra automaticamente 3 métricas além das padrão do K6:

| Métrica | Tipo | Descrição |
|---------|------|-----------|
| `stress_req_duration` | Trend | Duração das requisições (ms) |
| `stress_req_total` | Counter | Total de requisições enviadas |
| `stress_error_rate` | Rate | Taxa de respostas não-2xx |

---

## Custom Functions

As funções customizadas são definidas em `custom_functions.js` como um mapa exportado. Monte seu próprio arquivo em runtime para adicionar ou substituir funções sem rebuildar a imagem:

```bash
-v $(pwd)/custom_functions.js:/app/custom_functions.js
```

### Estrutura de uma função customizada

```js
// custom_functions.js
export const customFunctions = {
  /**
   * $meuNome(arg1, arg2)
   * args : string[] — argumentos do template (refs #env já resolvidas)
   * env  : object   — __ENV do K6 (todas as variáveis passadas com -e)
   * Retorne: string | number | boolean | null
   */
  meuNome: (args, env) => {
    return `${args[0]}-${Date.now()}`;
  },
};
```

### Funções incluídas por padrão

| Função no template | Implementação padrão |
|--------------------|---------------------|
| `$customFunction()` | Retorna `Date.now()` como string (Unix ms) |
| `$paddedNumber(value, width)` | Preenche com zeros à esquerda. Ex: `$paddedNumber(42,6)` → `"000042"` |
| `$randomChoice(a,b,c,...)` | Escolhe um dos valores aleatoriamente. Ex: `$randomChoice(A,B,C)` → `"B"` |

### Funções built-in (não precisam estar em `custom_functions.js`)

| Placeholder | Retorno | Exemplo |
|-------------|---------|---------|
| `$randomNumber(min, max)` | `number` | `$randomNumber(1,9999)` → `4821` |
| `$randomString(minLen, maxLen)` | `string` | `$randomString(5,10)` → `"aB3xZ"` |
| `$randomDate(start, end)` | `string` UTC | `$randomDate(2020-01-01,2026-12-31)` → `"2023-05-15 14:22:01"` |
| `$randomUUID()` | `string` | `"550e8400-e29b-41d4-a716-446655440000"` |
| `$randomBoolean()` | `boolean` | `true` ou `false` |
| `$timestamp()` | `number` | Unix ms atual |
| `$totalItems(arrayId)` | `number` | Contagem do array com aquele `$id` |
| `$toNumber(#envVar)` | `number` | `$toNumber(#otherVar)` lê `-e otherVar=100` → `100` |
| `$toString(#envVar)` | `string` | `$toString(#clientId)` lê `-e clientId=SAP` → `"SAP"` |

---

## Examples

### Template completo (cenário Kafka Proxy)

```json
{
    "name": "SbfDetSeparacao70030 - Centauro Stress Test",
    "method": "POST",
    "url": "https://kafka-proxy-api.dev.gcp.example.com/v2/publish",
    "headers": {
        "Content-Type": "application/json",
        "x-client-id": "SAP",
        "x-token": "seu-token-aqui"
    },
    "k6_options": {
        "vus": 10,
        "duration": "30s"
    },
    "payload": {
        "business_unit": "CENTAURO",
        "type": "SbfDetSeparacao70030",
        "identifier": "$randomString(8,12)",
        "total_records": "$totalItems(data)",
        "data": {
            "$type": "array",
            "$id": "data",
            "$minItems": 1,
            "$maxItems": 10,
            "$itemTemplate": {
                "cd_empresa": "$randomNumber(1,9999)",
                "cd_colmeia": "$randomString(3,8)",
                "cd_destino_separacao": "$randomNumber(1,999)",
                "cd_grupo_separacao": "$randomNumber(1,999)",
                "cd_funcionario": "$toNumber(#otherVar)",
                "dt_separacao": "$randomDate(2020-01-01,2026-12-31)",
                "dt_nota_fiscal": "$randomDate(2020-01-01,2026-12-31)",
                "dt_addrow": "$customFunction()"
            }
        }
    }
}
```

**Exemplo de payload gerado em runtime:**

```json
{
    "business_unit": "CENTAURO",
    "type": "SbfDetSeparacao70030",
    "identifier": "aB3xZqLm",
    "total_records": 2,
    "data": [
        {
            "cd_empresa": 4821,
            "cd_colmeia": "XwPq",
            "cd_destino_separacao": 312,
            "cd_grupo_separacao": 87,
            "cd_funcionario": 100,
            "dt_separacao": "2023-05-15 14:22:01",
            "dt_nota_fiscal": "2021-11-03 08:45:33",
            "dt_addrow": "1719619200000"
        },
        {
            "cd_empresa": 1337,
            "cd_colmeia": "MnRt",
            "cd_destino_separacao": 501,
            "cd_grupo_separacao": 204,
            "cd_funcionario": 100,
            "dt_separacao": "2024-08-22 07:10:55",
            "dt_nota_fiscal": "2022-03-17 16:30:00",
            "dt_addrow": "1719619200001"
        }
    ]
}
```

### Comando de execução do exemplo incluído

```bash
# Build (apenas uma vez)
docker build -t local-stress-test .

# Rodar o exemplo com 1 VU, 1 iteração (smoke test)
docker run --rm \
  -v $(pwd)/examples/template.json:/app/template.json \
  -v $(pwd)/custom_functions.js:/app/custom_functions.js \
  local-stress-test run /app/stress_test.js \
  -e otherVar=100 \
  --vus 1 --iterations 1

# Stress test completo (usa as opções do template: 10 VUs, 30s)
docker run --rm \
  -v $(pwd)/examples/template.json:/app/template.json \
  -v $(pwd)/custom_functions.js:/app/custom_functions.js \
  local-stress-test run /app/stress_test.js \
  -e otherVar=100
```

### Template com payload simples (sem array)

```json
{
    "name": "Health Check",
    "method": "GET",
    "url": "https://minha-api.com/health",
    "headers": {
        "x-client-id": "$toString(#clientId)"
    },
    "k6_options": {
        "vus": 5,
        "duration": "15s"
    },
    "payload": {}
}
```

```bash
docker run --rm \
  -v $(pwd)/health.json:/app/template.json \
  local-stress-test run /app/stress_test.js \
  -e clientId=MY_CLIENT \
  --vus 5 --duration 15s
```
