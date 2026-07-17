import { env } from "cloudflare:workers";
import { vi } from "vitest";

export async function resetState(maxBytes = 3221225472): Promise<void> {
  const listed = await env.FILES.list({ prefix: "objects/", limit: 1000 });
  if (listed.objects.length > 0) {
    await env.FILES.delete(listed.objects.map((object) => object.key));
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_reservations"),
    env.DB.prepare("DELETE FROM rate_limit_events"),
    env.DB.prepare("DELETE FROM cleanup_runs"),
    env.DB.prepare("DELETE FROM files"),
    env.DB.prepare(
      `UPDATE storage_usage
         SET used_bytes = 0,
             reserved_bytes = 0,
             max_bytes = ?1,
             updated_at = unixepoch()
         WHERE id = 1`,
    ).bind(maxBytes),
  ]);
}

export function mockSuccessfulTurnstile(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(Response.json({ success: true, hostname: "example.test" })),
  );
}

export interface CompletedUpload {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly previewPolicy: "inline" | "download_only";
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
  readonly deleteToken: string;
}
