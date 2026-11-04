/**
 * Holds traffic back until a startup check has passed.
 *
 * The check here is that the app and auth roles cannot bypass row-level
 * security (db/index.ts). If the database is unreachable at boot, that check
 * cannot run, and serving anyway would mean serving with roles nobody has
 * verified; if they turned out to be privileged, every request would run past
 * the policies. So until the check passes, every request but `/health` is
 * answered 503, and the check is retried in the background. `/health` stays
 * open so a probe can see why the instance is not ready.
 */

type Fetch = (request: Request, ...rest: any[]) => Response | Promise<Response>;

export interface StartupGateOptions {
  /** Resolves when it is safe to serve; throws otherwise. */
  verify: () => Promise<void>;
  /** A failure that retrying cannot fix: the process should stop. */
  isFatal: (err: unknown) => boolean;
  onFatal: (err: unknown) => void;
  /** Told about each failure that will be retried. */
  onRetry?: (err: unknown) => void;
  retryMs?: number;
}

/** Paths answered while the gate is shut. */
const ALWAYS_OPEN = new Set(["/health"]);

export function createStartupGate(options: StartupGateOptions) {
  const retryMs = options.retryMs ?? 2000;
  let ready = false;

  async function attempt(): Promise<void> {
    try {
      await options.verify();
      ready = true;
    }
    catch (err) {
      if (options.isFatal(err)) {
        options.onFatal(err);
        return;
      }
      options.onRetry?.(err);
      setTimeout(() => void attempt(), retryMs);
    }
  }

  return {
    /** The first attempt, awaited so a healthy boot serves at once. */
    start: () => attempt(),
    isReady: () => ready,
    wrap(fetch: Fetch): Fetch {
      return (request, ...rest) => {
        if (ready || ALWAYS_OPEN.has(new URL(request.url).pathname))
          return fetch(request, ...rest);

        return Response.json(
          { message: "Starting up: the database is not verified yet. Try again shortly." },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      };
    },
  };
}
