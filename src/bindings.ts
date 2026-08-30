interface OptionalBindings {
  readonly TURNSTILE_TEST_MODE?: string;
  readonly UPLOAD_ACCESS_CODE?: string;
}

export type Bindings = Env & OptionalBindings;
