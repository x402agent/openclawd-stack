---
title:
  page: "Set Up the NemoClawd Telegram Bridge for Remote Agent Chat"
  nav: "Set Up Telegram Bridge"
description: "Forward messages between Telegram and the sandboxed OpenClawd agent in the openclawd-stack."
keywords: ["nemoclawd telegram bridge", "telegram bot openclawd agent", "openclawd-stack telegram"]
topics: ["generative_ai", "ai_agents", "solana"]
tags: ["openclawd", "openshell", "telegram", "deployment", "nemoclawd"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 x402agent / openclawd-stack contributors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the Telegram Bridge

Forward messages between a Telegram bot and the OpenClawd agent running inside the NemoClawd sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClawd sandbox, either local or remote.
- A Telegram bot token from [BotFather](https://t.me/BotFather).

## Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the NemoClawd agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the `TELEGRAM_BOT_TOKEN` environment variable is set.

## Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClawd agent inside the sandbox and returns the agent response.

## Restrict Access by Chat ID

To restrict which Telegram chats can interact with the NemoClawd agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Deploy NemoClawd to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Telegram support.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
