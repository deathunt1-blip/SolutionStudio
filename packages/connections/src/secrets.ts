import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';

export interface SecretStore { put(value:string,reference?:string):Promise<string>; get(reference:string):Promise<string>; }
/** SQL stores opaque references only. Local secrets are encrypted with AES-256-GCM. */
export class LocalSecretStore implements SecretStore {
 private tail:Promise<unknown>=Promise.resolve();
 private key?:Buffer;
 constructor(private directory:string,private masterKey=process.env.SOURCE_SECRET_KEY){}
 private async encryptionKey(){
  if(this.key)return this.key;
  await mkdir(this.directory,{recursive:true});
  if(this.masterKey){if(!/^[a-f0-9]{64}$/i.test(this.masterKey))throw Error('SOURCE_SECRET_KEY 必须为64位十六进制');return this.key=Buffer.from(this.masterKey,'hex');}
  if(process.env.NODE_ENV==='production')throw Error('生产环境需要配置 SOURCE_SECRET_KEY 或外部 SecretStore');
  const filename=path.join(this.directory,'source-master.key');
  try{this.key=await readFile(filename);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;try{await writeFile(filename,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}this.key=await readFile(filename);}
  if(this.key.length!==32)throw Error('本地密钥文件无效');return this.key;
 }
 private async entries(){try{return JSON.parse(await readFile(path.join(this.directory,'source-secrets.enc.json'),'utf8')) as Record<string,{iv:string;tag:string;data:string}>;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw Error('无法读取加密连接配置');}}
 async put(value:string,reference=randomUUID()){
  const task=this.tail.then(async()=>{const key=await this.encryptionKey(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(reference));const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);const entries=await this.entries();entries[reference]={iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:encrypted.toString('base64')};const target=path.join(this.directory,'source-secrets.enc.json');await writeFile(target+'.tmp',JSON.stringify(entries),{mode:0o600});await rename(target+'.tmp',target);return reference;});
  this.tail=task.catch(()=>{});return task;
 }
 async get(reference:string){await this.tail;const item=(await this.entries())[reference];if(!item)throw Error('连接密钥不存在，请重新配置');try{const decipher=createDecipheriv('aes-256-gcm',await this.encryptionKey(),Buffer.from(item.iv,'hex'));decipher.setAAD(Buffer.from(reference));decipher.setAuthTag(Buffer.from(item.tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(item.data,'base64')),decipher.final()]).toString('utf8');}catch{throw Error('无法解密连接密钥，请检查密钥配置');}}
}
