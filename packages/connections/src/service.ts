import {randomUUID} from 'node:crypto';
import type {Database} from '../../knowledge/src/database.js';
import {HttpError} from '../../knowledge/src/service.js';
import type {RemoteSourceAdapter} from '../../core/src/sources.js';
import type {SecretStore} from './secrets.js';

export type AdapterFactory=(provider:string,credentials:{appId:string;appSecret:string})=>RemoteSourceAdapter;
const timestamp=(v:unknown)=>v instanceof Date?v.toISOString():String(v);
export class ConnectionService {
 private secrets=new Set<string>();
 private adapters=new Map<string,{revision:string;adapter:RemoteSourceAdapter}>();
 constructor(private db:Database,private store:SecretStore,private factory:AdapterFactory){}
 redact(value:string){let text=value;for(const secret of this.secrets)if(secret)text=text.replaceAll(secret,'[已隐藏]');return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').slice(0,500);}
 private public(row:any){return {id:row.id,provider:row.provider,name:row.name,appId:row.app_id,status:row.status,configured:Boolean(row.secret_ref),error:row.last_error||undefined,createdAt:timestamp(row.created_at),updatedAt:timestamp(row.updated_at)};}
 async list(){return (await this.db.query('SELECT * FROM external_connections ORDER BY created_at')).map(r=>this.public(r));}
 async get(id:string){const row=(await this.db.query('SELECT * FROM external_connections WHERE id=$1',[id]))[0];if(!row)throw new HttpError(404,'连接不存在');return this.public(row);}
 async create(input:{name:string;appId:string;appSecret:string}){
  this.secrets.add(input.appSecret);const ref=await this.store.put(input.appSecret),id=randomUUID();
  await this.db.query("INSERT INTO external_connections(id,provider,name,app_id,secret_ref,last_error) VALUES($1,'feishu',$2,$3,$4,'尚未测试资源权限')",[id,input.name,input.appId,ref]);return this.get(id);
 }
 async update(id:string,input:{name?:string;appId?:string;appSecret?:string;status?:'connected'|'disabled'}){
  const row=(await this.db.query('SELECT * FROM external_connections WHERE id=$1',[id]))[0];if(!row)throw new HttpError(404,'连接不存在');
  if(input.appSecret){this.secrets.add(input.appSecret);await this.store.put(input.appSecret,row.secret_ref);}
  const changed=Boolean(input.appSecret||input.appId&&input.appId!==row.app_id);
  const status=input.status==='disabled'?'disabled':changed||input.status==='connected'?'error':row.status;
  await this.db.query('UPDATE external_connections SET name=$1,app_id=$2,status=$3,last_error=$4,updated_at=now() WHERE id=$5',[input.name??row.name,input.appId??row.app_id,status,status==='error'?'请测试资源权限':row.last_error,id]);this.adapters.delete(id);return this.get(id);
 }
 async adapter(id:string){
  const row=(await this.db.query('SELECT * FROM external_connections WHERE id=$1',[id]))[0];if(!row)throw new HttpError(404,'连接不存在');if(row.status==='disabled')throw new HttpError(409,'连接已停用');
  const revision=timestamp(row.updated_at),cached=this.adapters.get(id);if(cached?.revision===revision)return cached.adapter;
  const secret=await this.store.get(row.secret_ref);this.secrets.add(secret);const adapter=this.factory(row.provider,{appId:row.app_id,appSecret:secret});this.adapters.set(id,{revision,adapter});return adapter;
 }
 async test(id:string,config:Record<string,unknown>){
  try{const result=await(await this.adapter(id)).test(config);await this.db.query("UPDATE external_connections SET status='connected',last_error=NULL WHERE id=$1",[id]);return {ok:true,...result};}
  catch(error){const message=this.redact(error instanceof Error?error.message:'连接测试失败');await this.db.query("UPDATE external_connections SET status='error',last_error=$1 WHERE id=$2 AND status<>'disabled'",[message,id]);throw new HttpError(400,message);}
 }
}
