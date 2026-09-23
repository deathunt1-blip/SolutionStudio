import type { Connection } from '../../knowledge/src/database.js';
import { queryText } from '../../knowledge/src/search.js';
import { duplicateRetrievalBuckets } from '../../deduplication/src/retrieval.js';
import type { HistoricalSectionReference, KnowledgeSection, ProjectFingerprint, SoftTags, TagDimension } from './types.js';
import { fingerprintDimensions, normalizeFingerprint, normalizeTag, tagValues, type TagAlias } from './taxonomy.js';
export interface RetrievalWeights {role:number;tags:number;application:number;object:number;topic:number;module:number;product:number;fts:number;quality:number;authority:number;freshness:number}
export const defaultRetrievalWeights:RetrievalWeights={role:5,tags:1.3,application:2,object:2,topic:1.8,module:1.8,product:1.5,fts:2.5,quality:1.2,authority:.35,freshness:.15};
export function sectionRecord(row:any):KnowledgeSection {
 const tags=row.tags as SoftTags??{};
 return {id:row.id,documentId:row.document_id,versionId:row.version_id,title:row.title,headingPath:row.heading_path,level:row.level,text:row.text,summary:row.summary,sectionRole:row.section_role,softTags:tags,tags:[...new Set(Object.values(tags).flat().map(tag=>tag.value))],applications:tagValues(tags,'applications'),targetObjects:tagValues(tags,'target_objects'),scenarios:tagValues(tags,'scenarios'),topics:tagValues(tags,'technical_topics'),modules:tagValues(tags,'system_modules'),products:tagValues(tags,'products'),reusable:row.reusable,quality:row.quality,authority:row.authority??'unknown',blueprint:{purpose:'',recommendedStructure:[],reusableTechnicalLogic:[],expectedFacts:[],projectSpecificElements:[],...row.blueprint},order:row.section_order};
}
function similarity(values:string[],tags:SoftTags,dimension:TagDimension,aliases:TagAlias[]) {
 if(!values.length)return 0;const targets=new Set(values.map(value=>normalizeTag(dimension,value,aliases)));let score=0;
 const productEquivalent=(a:string,b:string)=>{const contains=(token:string,label:string)=>/^[a-z][a-z\d._/-]*$/i.test(token)&&new RegExp(`(?<![a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z0-9])`,'i').test(label);return contains(a,b)||contains(b,a);};
 for(const value of targets){const confidence=Math.max(0,...(tags[dimension]??[]).filter(tag=>{const candidate=normalizeTag(dimension,tag.value,aliases);return candidate===value||dimension==='products'&&productEquivalent(value,candidate);}).map(tag=>tag.confidence));score+=confidence>=.8?confidence:confidence*.45;}
 return score/targets.size;
}
export async function retrieveSections(db:Connection,input:{role:string;fingerprint?:Partial<ProjectFingerprint>;products?:string[];query?:string;sourceIds?:string[];limit?:number;weights?:Partial<RetrievalWeights>}):Promise<HistoricalSectionReference[]> {
 const aliases=await db.query<TagAlias>('SELECT dimension,alias,canonical FROM knowledge_tag_aliases'),fingerprint=normalizeFingerprint(input.fingerprint??{},aliases);
 const stored=(await db.query("SELECT value FROM settings WHERE key='sectionRetrievalWeights'"))[0]?.value??{};
 const weights={...defaultRetrievalWeights};for(const [key,value] of Object.entries({...stored,...input.weights}))if(key in weights&&typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100)weights[key as keyof RetrievalWeights]=value;
 const expression=queryText(input.query??'','or'),params:unknown[]=[expression],rank="CASE WHEN $1='' THEN 0 ELSE ts_rank_cd(s.search_vector,to_tsquery('simple',$1)) END";
 let selected='';if(input.sourceIds?.length){params.push(input.sourceIds);selected=' AND (s.id=ANY($2::text[]) OR d.id=ANY($2::text[]))';}
 const rows=await db.query(`SELECT s.*,coalesce(d.canonical_title,d.title) AS document_title,e.quality AS document_quality,e.tags AS document_tags,
  (SELECT value#>>'{}' FROM classification_results WHERE version_id=s.version_id AND field='authority') AS authority,${rank} AS fts_rank
  FROM knowledge_sections s JOIN documents d ON d.id=s.document_id AND d.active_version_id=s.version_id
  LEFT JOIN document_enrichments e ON e.document_id=d.id AND e.version_id=s.version_id
  WHERE d.organization_id='default' AND d.workspace_id='default' AND d.scope='global' AND d.status='active'
   AND d.canonical_document_id IS NULL AND s.reusable=true
   AND lower(btrim(s.section_role)) NOT IN ('cover','toc','table_of_contents','title_page','封面','目录')${selected}`,params);
 const buckets=await duplicateRetrievalBuckets(db),bucketMap=new Map(buckets.documentIds.map((id,index)=>[id,buckets.buckets[index]]));
 const quality=(value:string)=>value==='preferred'?1:value==='good'?.5:0;
 const products=[...new Set([...fingerprint.products,...input.products??[]])];
 const scored=rows.map(row=>{
  const section=sectionRecord(row),tags:SoftTags={};
  // Document tags supply lower-confidence background; explicit section tags win.
  for(const dimension of Object.values(fingerprintDimensions)){const values=new Map<string,number>();for(const tag of (row.document_tags?.[dimension]??[]))values.set(tag.value,tag.confidence*.7);for(const tag of section.softTags[dimension]??[])values.set(tag.value,Math.max(values.get(tag.value)??0,tag.confidence));tags[dimension]=[...values].map(([value,confidence])=>({value,confidence}));}
  const topic=similarity(fingerprint.topics,tags,'technical_topics',aliases),module=similarity(fingerprint.modules,tags,'system_modules',aliases),app=similarity(fingerprint.applications,tags,'applications',aliases),object=similarity(fingerprint.targetObjects,tags,'target_objects',aliases),product=similarity(products,tags,'products',aliases);
  const general=(similarity(fingerprint.scenarios,tags,'scenarios',aliases)+similarity(fingerprint.environment,tags,'environment',aliases)+similarity(fingerprint.constraints,tags,'constraints',aliases))/3;
  const role=section.sectionRole===input.role?1:0,fts=Number(row.fts_rank)||0;
  const relevance=role*weights.role+app*weights.application+object*weights.object+topic*weights.topic+module*weights.module+product*weights.product+general*weights.tags+Math.min(1,fts)*weights.fts;
  const age=Math.max(0,(Date.now()-new Date(row.updated_at).getTime())/(365.25*86400000));
  const score=relevance+Math.max(quality(section.quality),quality(row.document_quality))*weights.quality+(section.authority==='authoritative'?1:section.authority==='reference'?.5:0)*weights.authority+weights.freshness/(1+age);
  return {section,documentTitle:row.document_title,score,use:'writing_reference' as const,relevance};
 }).filter(item=>item.relevance>0).sort((a,b)=>b.score-a.score||a.section.id.localeCompare(b.section.id));
 const counts=new Map<string,number>(),result:HistoricalSectionReference[]=[];
 for(const item of scored){const bucket=bucketMap.get(item.section.documentId)??item.section.documentId,limit=bucketMap.has(item.section.documentId)?1:2;if((counts.get(bucket)??0)>=limit)continue;counts.set(bucket,(counts.get(bucket)??0)+1);const {relevance:_,...reference}=item;result.push(reference);if(result.length>=Math.max(1,Math.min(30,input.limit??6)))break;}
 return result;
}
