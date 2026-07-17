export type InvitationStatus = "active" | "revoked";

export interface UploadInvitation {
  readonly id: string;
  readonly token_hash: string;
  readonly label: string;
  readonly status: InvitationStatus;
  readonly max_files: number;
  readonly max_bytes: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

export interface InvitationUsage {
  readonly used_files: number;
  readonly used_bytes: number;
}

export interface InvitationSession extends UploadInvitation, InvitationUsage {
  readonly session_id: string;
  readonly session_expires_at: number;
}
