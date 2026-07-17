import { DomainError } from "../domain/errors";

export interface PeekedStream {
  readonly prefix: Uint8Array;
  readonly stream: ReadableStream<Uint8Array>;
}

export async function peekStream(
  source: ReadableStream<Uint8Array>,
  maximumBytes = 4096,
): Promise<PeekedStream> {
  const [probeStream, uploadStream] = source.tee();
  const reader = probeStream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maximumBytes) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      const remaining = maximumBytes - total;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch {
    throw new DomainError("UPLOAD_FAILED", 500, "無法讀取上傳內容。");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { prefix, stream: uploadStream };
}
