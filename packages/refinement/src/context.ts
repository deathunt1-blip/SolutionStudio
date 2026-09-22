import type { DocumentRecord, ParsedDocument } from '../../core/src/types.js';
import type { Connection } from '../../knowledge/src/database.js';
import { documentRecord, documentSelect, scoped } from '../../knowledge/src/repository.js';
import type { CorpusContext, CorpusDocumentCard } from './types.js';
import { PostgreSQLDocumentSimilarityProvider } from './similarity.js';

/** Only the current version's explicit core confirmations can make a strong example. */
export function documentToCard(document:DocumentRecord, groups:string[]=[]):CorpusDocumentCard {
 const classification=document.classification;
 const userConfirmed=classification?.documentType.source==='user' && classification.authority.source==='user';
 return {id:document.id,versionId:document.activeVersionId,title:document.title,summary:document.summary,documentType:classification?.documentType.value,
  authority:classification?.authority.value,applications:classification?.applications.value??[],topics:classification?.topics.value??[],products:classification?.products.value??[],
  userConfirmed,sourceType:document.sourceType,sourcePath:document.sourcePath,contentHash:document.contentHash,groups,
  confidence:Math.min(classification?.documentType.confidence??0,classification?.authority.confidence??0),
  confirmedFields:userConfirmed?Object.fromEntries(Object.entries(classification!).filter(([,value])=>value?.source==='user')):undefined};
}

export async function buildCorpusCards(db:Connection,ids?:string[]):Promise<CorpusDocumentCard[]> {
 if(ids?.length===0)return [];
 const rows=await db.query(`${documentSelect} WHERE ${scoped} AND d.status IN ('active','needs_review')${ids?' AND d.id=ANY($1::text[])':''} ORDER BY d.id`,ids?[ids]:[]);
 const groups=await db.query<{document_id:string;name:string}>(`SELECT gd.document_id,g.name FROM knowledge_group_documents gd JOIN knowledge_groups g ON g.id=gd.group_id JOIN documents d ON d.id=gd.document_id WHERE ${scoped} ORDER BY g.name`);
 const memberships=new Map<string,string[]>();
 for(const row of groups)memberships.set(row.document_id,[...(memberships.get(row.document_id)??[]),row.name]);
 return rows.map(row=>documentToCard(documentRecord(row),memberships.get(row.id)??[]));
}

export class CorpusContextBuilder {
 constructor(private readonly db:Connection){}
 async cards(ids?:string[]){return buildCorpusCards(this.db,ids);}
 async build(document:DocumentRecord,parsed:ParsedDocument):Promise<CorpusContext> {
  const cards=await buildCorpusCards(this.db);
  const own=cards.find(card=>card.id===document.id)??documentToCard(document);
  // Parsed evidence provides useful retrieval terms for new documents before classification exists.
  const query={...own,summary:own.summary||parsed.plainText.slice(0,1600)};
  const ranked=await new PostgreSQLDocumentSimilarityProvider(this.db,cards).findSimilar(query,8);
  const eligible=cards.filter(card=>card.id!==document.id&&(!document.contentHash||card.contentHash!==document.contentHash));
  const distribution:Record<string,number>={};
  for(const card of eligible){const type=card.documentType??'unknown';distribution[type]=(distribution[type]??0)+1;}
  const groups=await this.db.query<{id:string;name:string;document_count:number}>(`SELECT g.id,g.name,count(d.id)::int AS document_count FROM knowledge_groups g LEFT JOIN knowledge_group_documents gd ON gd.group_id=g.id LEFT JOIN documents d ON d.id=gd.document_id AND ${scoped} AND d.status IN ('active','needs_review') GROUP BY g.id,g.name ORDER BY count(d.id) DESC,g.name LIMIT 30`);
  // Confirmed examples remain relevant, rather than filling the context with unrelated labels.
  return {similar:ranked.slice(0,5),confirmed:ranked.filter(item=>item.document.userConfirmed).slice(0,3).map(item=>item.document),distribution,
   groups:groups.map(group=>({id:group.id,name:group.name,documentCount:Number(group.document_count)}))};
 }
}

/** Small, valid JSON for the existing ingestion classifier. No authority or product facts. */
export function compactClassificationContext(context:CorpusContext):string {
 const cards=context.similar.slice(0,5).map(item=>({title:clip(item.document.title,120),type:item.document.documentType,
  applications:item.document.applications.slice(0,4),topics:item.document.topics.slice(0,5),groups:(item.document.groups??[]).slice(0,3),
  strength:item.document.userConfirmed?'strong':'weak',weight:item.document.userConfirmed?1:Math.min(0.3,item.weight)}));
 const payload={notice:'只辅助类型和主题；非人工结果最多弱参考，不能提供当前文件事实或权威证据。',similar:cards};
 while(Buffer.byteLength(JSON.stringify(payload),'utf8')>900&&payload.similar.length)payload.similar.pop();
 return JSON.stringify(payload);
}

function clip(value:string,bytes:number){let result='';for(const ch of value){if(Buffer.byteLength(result+ch,'utf8')>bytes)break;result+=ch;}return result;}
