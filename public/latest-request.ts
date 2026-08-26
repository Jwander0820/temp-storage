export interface LatestRequest {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
}

export interface LatestRequestCoordinator {
  begin(): LatestRequest;
}

export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let generation = 0;
  let activeController: AbortController | null = null;

  return {
    begin(): LatestRequest {
      activeController?.abort();
      const controller = new AbortController();
      const requestGeneration = ++generation;
      activeController = controller;

      return {
        signal: controller.signal,
        isCurrent: () => requestGeneration === generation,
        finish: () => {
          if (requestGeneration === generation) {
            activeController = null;
          }
        },
      };
    },
  };
}
