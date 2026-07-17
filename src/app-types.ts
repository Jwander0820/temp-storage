import type { Bindings } from "./bindings";

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    requestId: string;
  };
}
