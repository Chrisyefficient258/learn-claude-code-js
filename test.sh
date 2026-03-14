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