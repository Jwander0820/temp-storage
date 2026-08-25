export interface SecretBindings {
  readonly TURNSTILE_SECRET_KEY: string;
  readonly TURNSTILE_TEST_MODE?: string;
  readonly DELETE_TOKEN_PEPPER: string;
  readonly IP_HASH_PEPPER: string;
  readonly ADMIN_TOKEN: string;
  readonly UPLOAD_ACCESS_CODE?: string;
}

export type Bindings = Env & SecretBindings;
