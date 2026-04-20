---
title:
  page: "Switch NemoClawd Inference Models at Runtime"
  nav: "Switch Inference Models"
description: "Change the active inference model without restarting the NemoClawd sandbox in the openclawd-stack."
keywords: ["switch nemoclawd inference model", "change inference runtime", "xai grok nvidia nim ollama deepsolana"]
topics: ["generative_ai", "ai_agents", "solana"]
tags: ["openclawd", "openshell", "inference_routing", "nemoclawd", "xai"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 x402agent / openclawd-stack contributors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Switch Inference Models at Runtime

Change the active inference model while the NemoClawd sandbox is running.
No restart is required.

## Prerequisites

- A running NemoClawd sandbox.
- The OpenShell CLI on your `PATH`.

## Switch to xAI Grok

Set the provider to `xai` and specify a Grok model from [x.ai/api](https://x.ai/api):

```console
$ openshell inference set --provider xai --model grok-4.20-reasoning
```

This requires the `XAI_API_KEY` environment variable.
The `nemoclaw onboard` command prompts for this key and stores it in `~/.nemoclaw/credentials.json` on first run.

## Switch to NVIDIA Cloud

Set the provider to `nvidia-nim` and specify a model from [build.nvidia.com](https://build.nvidia.com):

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

This requires the `NVIDIA_API_KEY` environment variable.

## Switch to Local Ollama DeepSolana

When Ollama is running on the host, select the `ollama-local` provider and the `8bit/DeepSolana` model:

```console
$ openshell inference set --no-verify --provider ollama-local --model 8bit/DeepSolana
```

No API key is required for local Ollama inference.

## Verify the Active Model

Run the status command to confirm the change:

```console
$ openclaw nemoclaw status
```

Add the `--json` flag for machine-readable output:

```console
$ openclaw nemoclaw status --json
```

The output includes the active provider, model, and endpoint.

## Available Models

The following table lists the models NemoClawd ships with out of the box.
You can switch to any of these models at runtime.

| Provider | Model ID | Label | Context Window | Max Output |
|---|---|---|---|---|
| `xai` | `grok-4.20-reasoning` | Grok 4.20 Reasoning | 256,000 | 16,384 |
| `xai` | `grok-4.20-multi-agent` | Grok 4.20 Multi-Agent (4–16 agents) | 256,000 | 16,384 |
| `xai` | `grok-4-1-fast` | Grok 4.1 Fast | 131,072 | 8,192 |
| `ollama-local` | `8bit/DeepSolana` | DeepSolana (local) | 32,768 | 4,096 |
| `nvidia-nim` | `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia-nim` | `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia-nim` | `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia-nim` | `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

## Related Topics

- [Inference Profiles](../reference/inference-profiles.md) for full profile configuration details.
