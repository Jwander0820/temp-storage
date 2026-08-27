export type InvitationLabelKind = "upload" | "browse";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function createDefaultInvitationLabel(
  kind: InvitationLabelKind,
  date = new Date(),
): string {
  const calendarDate = [
    date.getFullYear(),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
  ].join("");
  const localTime = [
    twoDigits(date.getHours()),
    twoDigits(date.getMinutes()),
    twoDigits(date.getSeconds()),
  ].join("");

  return `${kind}-${calendarDate}-${localTime}`;
}
