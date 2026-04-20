export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  trigger?: string;
  channelId?: string;
};

export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

export type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSendingResult = {
  content?: string;
  cancel?: boolean;
};

export type PluginHookSessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

export type PluginHookSessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};

export type PluginHookGatewayStartEvent = {
  port: number;
};

export type PluginHookBeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type PluginHookBeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
};

export type PluginHookAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type PluginHookHandlerMap = {
  before_prompt_build: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext
  ) => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void;
  message_sending: (
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext
  ) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void;
  session_start: (
    event: PluginHookSessionStartEvent,
    ctx: { sessionId: string; sessionKey?: string; agentId?: string }
  ) => Promise<void> | void;
  session_end: (
    event: PluginHookSessionEndEvent,
    ctx: { sessionId: string; sessionKey?: string; agentId?: string }
  ) => Promise<void> | void;
  gateway_start: (
    event: PluginHookGatewayStartEvent,
    ctx: { port?: number }
  ) => Promise<void> | void;
  before_reset: (
    event: PluginHookBeforeResetEvent,
    ctx: PluginHookAgentContext
  ) => Promise<void> | void;
  before_compaction: (
    event: PluginHookBeforeCompactionEvent,
    ctx: PluginHookAgentContext
  ) => Promise<void> | void;
  agent_end: (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext
  ) => Promise<void> | void;
};

export type PluginHookName = keyof PluginHookHandlerMap;

export type PluginLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export type OpenClawPluginToolContext = {
  config?: unknown;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sandboxed?: boolean;
};

export type OpenClawPluginApi = {
  id: string;
  name: string;
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: unknown, opts?: { name?: string; names?: string[]; optional?: boolean }) => void;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number }
  ) => void;
};
