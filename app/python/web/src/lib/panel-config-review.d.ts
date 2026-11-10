export function configError(error: unknown): Error;
export function reviewConfig(error: unknown, options: {
  draft: unknown;
  latest: () => Promise<unknown>;
  raw?: boolean;
}): Promise<never>;
