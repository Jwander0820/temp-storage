import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      TURNSTILE_SECRET_KEY: string;
      DELETE_TOKEN_PEPPER: string;
      IP_HASH_PEPPER: string;
      ADMIN_TOKEN: string;
      UPLOAD_ACCESS_CODE: string;
    }
  }
}

export {};
