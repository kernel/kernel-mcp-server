// The SDK defaults to a 60s request timeout with 2 retries, and it retries timeouts.
// Browser scripts and shell commands routinely run longer than 60s, so those defaults
// abort the request mid-operation and then replay it. Aborting does not stop the work:
// the browser VM runs the script to completion, so each replay executes it again against
// the same live page. Long, mutating operations wait for the server-side budget instead,
// and are never retried.
const LONG_OPERATION_HEADROOM_MS = 30_000;

export function longOperationOptions(serverBudgetSec: number) {
  return {
    timeout: serverBudgetSec * 1_000 + LONG_OPERATION_HEADROOM_MS,
    maxRetries: 0,
  };
}
