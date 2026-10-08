export async function limitedFormData(request: Request, limit: number): Promise<FormData> {
  if (Number(request.headers.get('content-length')) > limit)
    throw new Error('Upload is too large. Maximum image size is 5 MB.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing form data.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Upload is too large. Maximum image size is 5 MB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  return new Response(body, {
    headers: { 'content-type': request.headers.get('content-type') || '' },
  }).formData();
}
