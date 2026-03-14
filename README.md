# learn-claude-code-js

原python版本：https://github.com/shareAI-lab/learn-claude-code

src是按照原agents目录直接迁移过来的。只增加了client.js

## why fix client.js

我的cc用的是中转站https://foxcode.rjj.cc/
所以，直接用@anthropic-ai/sdk会报403错误。

首先测试

```sh
curl https://code.newcli.com/claude/aws/v1/messages \
  -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 10,
    "messages": [
      {"role": "user", "content": "hello"}
    ]
  }'
```

返回结果

```json
{
  "content": [
    {
      "text": "Hey! How can I help you today?",
      "type": "text"
    }
  ],
  "model": "claude-opus-4-6",
  "role": "assistant",
  "stop_reason": "max_tokens",
  "stop_sequence": null,
  "type": "message",
  "usage": {
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 0
    },
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "inference_geo": "not_available",
    "input_tokens": 4,
    "output_tokens": 11,
    "service_tier": "standard"
  }
}
```

然后快速mock一个src/client.js即可

## prepare

create src/.env

```
ANTHROPIC_BASE_URL=https://code.newcli.com/claude/aws/v1
ANTHROPIC_API_KEY=your key
MODEL_ID=claude-sonnet-4-6
ANTHROPIC_API_VERSION=2023-06-01
```

## run

```sh
$ npm run s01
```