---
title:
  page: "NemoClawd Inference Profiles"
  nav: "Inference Profiles"
description: "Configuration reference for NemoClawd inference profiles — xAI Grok, Ollama (DeepSolana), NVIDIA Cloud, vLLM."
keywords: ["nemoclawd inference profiles", "nemoclawd deepsolana", "nemoclawd ollama", "nemoclawd nvidia cloud provider", "nemoclawd xai grok"]
topics: ["generative_ai", "ai_agents", "solana"]
tags: ["openclawd", "openshell", "inference_routing", "llms", "ollama", "deepsolana", "xai", "nemoclawd"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 x402agent / openclawd-stack contributors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Inference Profiles

NemoClawd ships with three inference profiles defined in `blueprint.yaml`.
Each profile configures an OpenShell inference provider and model route.
The NemoClawd agent inside the sandbox uses whichever model is active.
Inference requests are routed transparently through the OpenShell gateway inside the openclawd-stack.

## Default: xAI Grok 4.20

When `XAI_API_KEY` is present during `nemoclaw onboard`, NemoClawd:

1. Automatically selects the `xai` provider
2. Registers Grok 4.20 Reasoning as the default model
3. Configures the OpenShell inference route

```console
$ openshell provider create --name xai --type openai \
    --credential "OPENAI_API_KEY=$XAI_API_KEY" \
    --config "OPENAI_BASE_URL=https://api.x.ai/v1"

$ openshell inference set --provider xai --model grok-4.20-reasoning
```

Grok 4.20 covers chat, reasoning, vision, structured output, and voice for the NemoClawd runtime.
For deep-research modes (4–16 agents), switch to `grok-4.20-multi-agent`.

## Fallback: Ollama + `8bit/DeepSolana`

When Ollama is detected on `localhost:11434` during `nemoclaw onboard`, NemoClawd:

1. Registers the `ollama-local` provider
2. Pulls `8bit/DeepSolana` (`ollama pull 8bit/DeepSolana`)
3. Leaves `ollama-local` available as a no-API-key fallback route

DeepSolana is a Solana-tuned model that understands Pump-Fun mechanics, token launches, DeFi strategies, and wallet narration out of the box.

```console
$ openshell provider create --name ollama-local --type openai \
    --credential "OPENAI_API_KEY=ollama" \
    --config "OPENAI_BASE_URL=http://host.openshell.internal:11434/v1"

$ openshell inference set --no-verify --provider ollama-local --model 8bit/DeepSolana
```

## Profile Summary

| Profile | Provider | Model | Endpoint | Use Case |
|---|---|---|---|---|
| `xai` (default) | xAI | `grok-4.20-reasoning` | `api.x.ai` | Production. Requires `XAI_API_KEY`. Grok chat, vision, voice, multi-agent. |
| `ollama-local` | Ollama | `8bit/DeepSolana` | `localhost:11434` | Local inference. No API key required. |
| `nvidia-nim` | NVIDIA Cloud | `nvidia/nemotron-3-super-120b-a12b` | `integrate.api.nvidia.com` | GPU-cloud fallback. Requires NVIDIA API key. |

## Available xAI Grok Models

The `xai` provider registers the following Grok 4.x models from [x.ai/api](https://x.ai/api):

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `grok-4.20-reasoning` | Grok 4.20 Reasoning | 256,000 | 16,384 |
| `grok-4.20-multi-agent` | Grok 4.20 Multi-Agent (4–16 agents) | 256,000 | 16,384 |
| `grok-4-1-fast` | Grok 4.1 Fast | 131,072 | 8,192 |
| `grok-imagine-image` | Grok Imagine (image gen + edit) | — | — |

## Available NVIDIA Cloud Models

The `nvidia-nim` provider registers the following models from [build.nvidia.com](https://build.nvidia.com):

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

## Switching Models at Runtime

After the sandbox is running, switch models with the OpenShell CLI:

```console
# Switch between Grok models
$ openshell inference set --provider xai --model grok-4.20-multi-agent

# Switch to a different Ollama model
$ ollama pull llama3
$ openshell inference set --no-verify --provider ollama-local --model llama3

# Switch to NVIDIA Cloud
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

The change takes effect immediately.
No sandbox restart is needed.

## `xai` — Default (Grok 4.20 Reasoning)

- **Provider type:** `openai` (OpenAI-compatible)
- **Endpoint:** `https://api.x.ai/v1`
- **Model:** `grok-4.20-reasoning`
- **Credential:** `XAI_API_KEY` environment variable
- **Get a key:** [x.ai/api](https://x.ai/api)

## `ollama-local` — Local Fallback (DeepSolana)

- **Provider type:** `openai` (OpenAI-compatible)
- **Endpoint:** `http://host.openshell.internal:11434/v1`
- **Model:** `8bit/DeepSolana`
- **Credential:** `OPENAI_API_KEY=ollama` (placeholder, Ollama doesn't require auth)
- **Install:** `brew install ollama` (macOS) or [ollama.ai](https://ollama.ai)

## `nvidia-nim` — NVIDIA Cloud

- **Provider type:** `nvidia`
- **Endpoint:** `https://integrate.api.nvidia.com/v1`
- **Model:** `nvidia/nemotron-3-super-120b-a12b`
- **Credential:** `NVIDIA_API_KEY` environment variable

Get an API key from [build.nvidia.com](https://build.nvidia.com).
The `nemoclaw onboard` command prompts for this key and stores it in `~/.nemoclaw/credentials.json`.
