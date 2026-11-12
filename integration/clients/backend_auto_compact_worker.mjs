import { createInterface } from 'node:readline';
import { query } from '../cli-backend/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { CliWorker } from '../cli-backend/worker.mjs';
import { WorkerError } from '../cli-backend/helpers.mjs';

// Test entrypoint only: the production worker, broker, hooks and genuine SDK
// remain unchanged. Only the documented CLI environment threshold is added.
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
function observedHook(phase) {
  return { hooks: [async value => {
    emit({ type: 'backend_test_hook', phase, trigger: value.trigger });
    return {};
  }] };
}
const worker = new CliWorker({
  emit,
  onClosed: () => { input.close(); process.stdin.pause(); },
  queryFactory: args => query({ ...args, options: { ...args.options,
    env: { ...args.options.env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '10' },
    hooks: { ...args.options.hooks,
      PreCompact: [...(args.options.hooks?.PreCompact ?? []), observedHook('pre')],
      PostCompact: [...(args.options.hooks?.PostCompact ?? []), observedHook('post')],
    },
  } }),
});
let chain = Promise.resolve();
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { worker.fail(new WorkerError('invalid_ipc')); return; }
  if (message.type === 'close') { worker.close(); return; }
  if (message.type === 'backend_test_context') {
    chain = chain.then(async () => {
      const output = { type: 'backend_test_context', request_id: message.request_id };
      try {
        const value = await worker.query.getContextUsage({ detail: 'summary' });
        for (const key of ['totalTokens', 'maxTokens', 'rawMaxTokens', 'autoCompactThreshold']) output[key] = Number.isFinite(value[key]) ? value[key] : null;
        output.isAutoCompactEnabled = value.isAutoCompactEnabled === true;
      } catch { output.unavailable = true; }
      emit(output);
    }).catch(error => worker.fail(error));
    return;
  }
  chain = chain.then(() => worker.handle(message)).catch(error => worker.fail(error));
});
input.on('close', () => worker.close());
process.on('uncaughtException', () => worker.fail(new WorkerError('inference_failed')));
process.on('unhandledRejection', () => worker.fail(new WorkerError('inference_failed')));
process.on('SIGTERM', () => worker.close()); process.on('SIGINT', () => worker.close());
