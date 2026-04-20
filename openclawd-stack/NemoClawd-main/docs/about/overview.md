---
title:
  page: "NemoClawd Overview — What It Does and How It Fits Together"
  nav: "Overview"
description: "NemoClawd sandboxes OpenClawd with xAI Grok inference, Solana tooling, and declarative policy inside the openclawd-stack."
keywords: ["nemoclawd overview", "openclawd openshell sandbox plugin", "clawd solana agent"]
topics: ["generative_ai", "ai_agents", "solana"]
tags: ["openclawd", "openshell", "sandboxing", "inference_routing", "blueprints", "nemoclawd", "solana", "xai"]
content:
  type: concept
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 x402agent / openclawd-stack contributors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Overview

NemoClawd is the [OpenClawd](https://openclaw.ai) plugin for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell), shipped as part of the `openclawd-stack`.
It moves OpenClawd into a sandboxed environment where every network request, file access, inference call, and Solana signing operation is governed by declarative policy.

| Capability              | Description                                                                                                                                          |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Sandbox OpenClawd       | Creates an OpenShell sandbox pre-configured for OpenClawd, with strict filesystem and network policies applied from the first boot.                   |
| Route inference         | Configures OpenShell inference routing so agent traffic flows through xAI Grok 4.20, Ollama DeepSolana, or NVIDIA Nemotron through [build.nvidia.com](https://build.nvidia.com). |
| Manage the lifecycle    | Handles blueprint versioning, digest verification, sandbox setup, and `$CLAWD` runtime wiring.                                                        |

## Challenge

Autonomous Solana agents like OpenClawd can make arbitrary network requests, access the host filesystem, call any inference endpoint, and sign transactions against live wallets. Without guardrails, this creates security, cost, and compliance risks that grow as agents run unattended.

## Benefits

NemoClawd provides the following benefits.

| Benefit                    | Description                                                                                                            |
|----------------------------|------------------------------------------------------------------------------------------------------------------------|
| Sandboxed execution        | Every agent runs inside an OpenShell sandbox with Landlock, seccomp, and network namespace isolation. No access is granted by default. |
| xAI Grok inference         | Agent traffic routes through xAI Grok 4.20 by default, with optional Ollama DeepSolana (`8bit/DeepSolana`) and NVIDIA cloud fallback. |
| Declarative network policy | Egress rules are defined in YAML. Unknown hosts are blocked and surfaced to the operator for approval.                 |
| Single CLI                 | The `nemoclaw` command orchestrates the full openclawd-stack: gateway, sandbox, inference provider, Solana RPC, Privy wallets, and network policy. |
| Blueprint lifecycle        | Versioned blueprints handle sandbox creation, digest verification, and reproducible setup.                             |
| $CLAWD-native              | Treats `$CLAWD` (`8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`) as a first-class runtime citizen for payments, buybacks, and rewards. |

## Use Cases

You can use NemoClawd for various use cases including the following.

| Use Case                  | Description                                                                                  |
|---------------------------|----------------------------------------------------------------------------------------------|
| Always-on Solana operator | Run a NemoClawd assistant with a funded Privy wallet, controlled network access, and operator-approved egress. |
| Sandboxed testing         | Test agent behavior against mainnet, devnet, or a local `solana-test-validator` before granting broader permissions. |
| Remote GPU deployment     | Deploy a sandboxed agent to a remote Brev GPU instance for persistent operation with Telegram narration. |
| Pump.fun research         | Use the openclawd-stack multi-agent research mode (4–16 Grok agents) for live token analysis. |

## Next Steps

Explore the following pages to learn more about NemoClawd.

- [How It Works](../about/how-it-works.md) to understand the key concepts behind NemoClawd.
- [Quickstart](../get-started/quickstart.md) to install NemoClawd and run your first agent.
- [Switch Inference Providers](../inference/switch-inference-providers.md) to configure the inference provider.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) to manage egress approvals.
- [Deploy to a Remote GPU Instance](../deployment/deploy-to-remote-gpu.md) for persistent operation.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) to observe agent behavior.
