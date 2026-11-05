import type { DomainAdapter } from "./types";
import { dispatchAdapter } from "./dispatch";
import { inventoryAdapter } from "./inventory";

export const adapters: Record<string, DomainAdapter> = {
  dispatch: dispatchAdapter,
  inventory: inventoryAdapter,
};
