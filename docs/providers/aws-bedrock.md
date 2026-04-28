---
title: AWS Bedrock
description: Anthropic and Meta models via AWS Bedrock with SigV4 signing.
sidebar_position: 5
---

# AWS Bedrock

The Bedrock provider uses the AWS ConverseStream API with Signature V4 signing. It supports Anthropic and Meta models hosted on Bedrock and translates events to canonical format.

## Setup

### Environment variables

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."  # optional, for temporary credentials
```

### Engine config

Bedrock does not use the standard `providers` config block. It is initialized via `BedrockOptions`:

```go
type BedrockOptions struct {
    Region          string // default: "us-east-1"
    AccessKeyID     string
    SecretAccessKey  string
    SessionToken    string
}
```

## Region

Default region is `us-east-1`. Override via `BedrockOptions.Region`.

## Model routing

Models are routed to Bedrock when the name contains `amazon.`, `anthropic.`, or `meta.` as a substring. These are the standard Bedrock model ID prefixes.

Examples:
- `anthropic.claude-3-5-sonnet-20241022-v2:0`
- `meta.llama3-1-70b-instruct-v1:0`

## Authentication

The provider implements AWS Signature V4 signing internally. It does not depend on the AWS SDK. Credentials are resolved in this order:

1. Values passed in `BedrockOptions`
2. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`)

## Event translation

Bedrock's ConverseStream returns events in a format different from the direct Anthropic API. The provider translates these into the same canonical `LlmStreamEvent` types used by all other providers.
