export type ReservationStatus = "reserved" | "consumed" | "expired" | "cancelled";

export interface UploadReservation {
  readonly id: string;
  readonly file_id: string;
  readonly reserved_bytes: number;
  readonly status: ReservationStatus;
  readonly created_at: number;
  readonly expires_at: number;
  readonly quota_released_at: number | null;
  readonly invitation_id: string | null;
}

export interface ReserveUploadInput {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly declaredMime: string | null;
  readonly turnstileToken: string;
  readonly accessCode: string | null;
}
