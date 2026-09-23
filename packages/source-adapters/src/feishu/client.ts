export interface FeishuCredentials { appId:string; appSecret:string }
export interface FeishuClientOptions {
  /** Constructor-only test transport. Never populate these values from source configuration. */
  fetch?:typeof fetch; baseUrl?:string; minIntervalMs?:number; retryBaseMs?:number; maxRetries?:number;
  timeoutMs?:number; maxJsonBytes?:number; maxDownloadBytes?:number; exportPollMs?:number;
}
type Envelope = { code?:number; data?:Record<string,unknown>; tenant_access_token?:string; expire?:number };
export class FeishuApiError extends Error {
  constructor(public readonly status:number,public readonly code?:number) {
    super(`飞书接口请求失败（HTTP ${status}${code === undefined ? '' : `，code ${code}`}）。请检查应用权限与资源授权后重试。`);
  }
}
const pause = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
const expired = new Set([99991661,99991663,99991664,99991668,99991677]);

export class FeishuClient {
  private readonly transport:typeof fetch;
  private readonly baseUrl:string;
  private token?:{value:string;expiresAt:number};
  private refresh?:Promise<string>;
  private throttle:Promise<void> = Promise.resolve();
  private nextRequest=0;
  readonly exportPollMs:number;
  constructor(private readonly credentials:FeishuCredentials,private readonly options:FeishuClientOptions={}) {
    if (!credentials.appId?.trim() || !credentials.appSecret?.trim()) throw new Error('请填写飞书 App ID 和 App Secret');
    const base = new URL(options.baseUrl ?? 'https://open.feishu.cn/open-apis');
    const official = base.origin === 'https://open.feishu.cn' && base.pathname.replace(/\/$/,'') === '/open-apis';
    const local = base.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname);
    if ((!official && !local) || base.username || base.password || base.search || base.hash) throw new Error('飞书 API 地址无效');
    this.baseUrl=base.href.replace(/\/$/,''); this.transport=options.fetch ?? fetch; this.exportPollMs=options.exportPollMs ?? 1000;
  }
  private async limit() {
    const wait = this.throttle.then(async()=>{await pause(Math.max(0,this.nextRequest-Date.now()));this.nextRequest=Date.now()+(this.options.minIntervalMs ?? 250);});
    this.throttle=wait.catch(()=>{}); await wait;
  }
  private async bytes(response:Response,limit:number):Promise<Uint8Array> {
    if (Number(response.headers.get('content-length') ?? 0)>limit) { await response.body?.cancel(); throw new Error('飞书响应超过读取大小上限'); }
    const reader=response.body?.getReader(); if (!reader) return new Uint8Array();
    const parts:Uint8Array[]=[];let size=0;
    try { while(true) { const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
      if(size>limit){await reader.cancel();throw new Error('飞书响应超过读取大小上限');}parts.push(next.value); } }
    catch(error){if(error instanceof Error && error.message==='飞书响应超过读取大小上限')throw error;throw new Error('飞书响应读取失败，请重试');}
    const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.byteLength;}return result;
  }
  private async send(path:string,method:'GET'|'POST',body:unknown,token?:string):Promise<Response> {
    if (!/^\/(?:auth|wiki|sheets|drive|docx)\//.test(path) || path.includes('://') || path.includes('\\') || path.includes('/../')) throw new Error('飞书接口路径无效');
    const maxRetries=Math.max(0,Math.min(5,this.options.maxRetries ?? 3));
    for(let attempt=0;attempt<=maxRetries;attempt++){
      await this.limit();let response:Response;
      try { response=await this.transport(this.baseUrl+path,{method,redirect:'error',signal:AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}); }
      catch { if(attempt<maxRetries){await pause((this.options.retryBaseMs ?? 500)*2**attempt);continue;}throw new Error('无法连接飞书开放平台，请检查网络后重试'); }
      if ((response.status===429 || response.status>=500) && attempt<maxRetries) {
        const retryAfter=Number(response.headers.get('retry-after'));
        await response.body?.cancel();await pause(Math.min(10_000,Math.max((this.options.retryBaseMs ?? 500)*2**attempt,Number.isFinite(retryAfter)?retryAfter*1000:0)));continue;
      }
      return response;
    }
    throw new Error('飞书请求重试次数已用尽');
  }
  private async envelope(response:Response):Promise<Envelope> {
    const bytes=await this.bytes(response,this.options.maxJsonBytes ?? 8*1024*1024);
    let json:Envelope;try{json=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new FeishuApiError(response.status);}
    if (!json || typeof json!=='object' || Array.isArray(json)) throw new FeishuApiError(response.status);
    if (!response.ok || json.code!==0) throw new FeishuApiError(response.status,typeof json.code==='number'?json.code:undefined);
    return json;
  }
  async accessToken():Promise<string> {
    if(this.token && this.token.expiresAt>Date.now())return this.token.value;
    if(this.refresh)return this.refresh;
    this.refresh=(async()=>{const json=await this.envelope(await this.send('/auth/v3/tenant_access_token/internal','POST',{app_id:this.credentials.appId,app_secret:this.credentials.appSecret}));
      if(typeof json.tenant_access_token!=='string' || !json.tenant_access_token || !Number.isFinite(json.expire) || json.expire!<=0) throw new Error('飞书返回了无效的授权结果');
      this.token={value:json.tenant_access_token,expiresAt:Date.now()+Math.max(1,json.expire!-Math.min(60,json.expire!/10))*1000};return this.token.value;})();
    try{return await this.refresh;}finally{this.refresh=undefined;}
  }
  private invalidate(token:string){if(this.token?.value===token)this.token=undefined;}
  async json(path:string,method:'GET'|'POST'='GET',body?:unknown):Promise<Record<string,unknown>> {
    for(let attempt=0;attempt<2;attempt++) {const token=await this.accessToken();
      try{return (await this.envelope(await this.send(path,method,body,token))).data ?? {};}
      catch(error){if(attempt===0 && error instanceof FeishuApiError && (error.status===401 || expired.has(error.code ?? 0))){this.invalidate(token);continue;}throw error;}
    }
    throw new Error('飞书授权刷新失败');
  }
  async download(path:string):Promise<{buffer:Uint8Array;mimeType:string;filename?:string}> {
    for(let attempt=0;attempt<2;attempt++){const token=await this.accessToken();const response=await this.send(path,'GET',undefined,token);
      if(!response.ok || (response.headers.get('content-type') ?? '').includes('application/json')){
        try{await this.envelope(response);throw new Error('飞书未返回可下载的文件');}
        catch(error){if(attempt===0 && error instanceof FeishuApiError && (error.status===401 || expired.has(error.code ?? 0))){this.invalidate(token);continue;}throw error;}
      }
      const disposition=response.headers.get('content-disposition') ?? '';let filename:string|undefined;
      const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];const plain=/filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
      try{filename=encoded?decodeURIComponent(encoded):plain?.[1] ?? plain?.[2];}catch{filename=undefined;}
      if(filename)filename=filename.replaceAll('\\','/').split('/').pop()?.replace(/[\x00-\x1f]/g,'').trim();
      return {buffer:await this.bytes(response,this.options.maxDownloadBytes ?? 64*1024*1024),mimeType:(response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0],filename};
    }
    throw new Error('飞书授权刷新失败');
  }
}
