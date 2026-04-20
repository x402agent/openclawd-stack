import type { Command } from 'commander';
import { registerBenchmarkCommand } from '../commands/benchmark.js';
import { registerContextCommand } from '../commands/context.js';
import { registerInjectCommand } from '../commands/inject.js';
import { registerObserveCommand } from '../commands/observe.js';
import { registerReflectCommand } from '../commands/reflect.js';
import { registerEmbedCommand } from '../commands/embed.js';
import { registerInboxCommand } from '../commands/inbox.js';
import { registerMaintainCommand } from '../commands/maintain.js';
import { registerPatchCommand } from '../commands/patch.js';
import { registerTailscaleCommands } from '../commands/tailscale.js';

export function registerCliCommands(program: Command): Command {
  registerBenchmarkCommand(program);
  registerContextCommand(program);
  registerInjectCommand(program);
  registerObserveCommand(program);
  registerReflectCommand(program);
  registerEmbedCommand(program);
  registerInboxCommand(program);
  registerMaintainCommand(program);
  registerPatchCommand(program);
  registerTailscaleCommands(program);
  return program;
}
