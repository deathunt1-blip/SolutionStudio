export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
  return body as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export interface UploadResult { filename: string; status: 'queued' | 'duplicate' | 'error'; documentId?: string; message?: string }
export function uploadFile(file: File, onProgress: (percentage: number) => void, keep = false, documentId?: string): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/upload?duplicate=${keep ? 'keep' : 'skip'}`);
    request.timeout = 180_000;
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = () => reject(new Error('上传中断，请检查网络后重试。'));
    request.ontimeout = () => reject(new Error('上传超时，请重试。'));
    request.onload = () => {
      try {
        const data = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300) throw new Error(data.message || data.error || '上传失败');
        if (!data.results?.[0]) throw new Error('服务器未返回上传结果');
        resolve(data.results[0]);
      } catch (error) { reject(error); }
    };
    const data = new FormData();
    if (documentId) data.append('documentId', documentId);
    data.append('files', file);
    request.send(data);
  });
}
