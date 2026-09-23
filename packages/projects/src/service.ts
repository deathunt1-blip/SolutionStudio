import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Classification, LLMConfig, LLMProvider, ParsedDocument } from '../../core/src/types.js';
import { estimatedModelCost, modelProfile } from '../../llm/src/models.js';
import type { Connection, Database } from '../../knowledge/src/database.js';
import { HttpError, type KnowledgeService } from '../../knowledge/src/service.js';
import { parseDocument } from '../../parsers/src/index.js';
import { chunkDocument, extractiveSummary } from '../../ingestion/src/chunking.js';
import { indexText, queryText } from '../../knowledge/src/search.js';
import { normalizedContentHash } from '../../deduplication/src/detector.js';
import { SceneLabReportAdapter } from './scenelab.js';
import { StructuredService } from '../../structured/src/service.js';
import { engineeringOpticsConflicts } from './optics.js';
import { buildRequirementRequests, extractRequirementsAI, parseRequirements, requirementEntries, requirementQuestions, stableId, type RequirementSource, type RequirementExtractionOptions } from './requirements.js';
import type { ContextPatch, EngineeringData, LockedFact, Project, ProjectAsset, ProjectConflict, ProjectContext, ProjectInput, ProjectRequirements, SourceReference } from './types.js';

const scope="p.organization_id='default' AND p.workspace_id='default'";
const date=(value:any)=>value instanceof Date?value.toISOString():String(value);
const field=<T>(value:T)=>({value,confidence:1,source:'metadata' as const});
const classification:Classification={documentType:field('contract_or_requirement'),authority:field('reference'),applications:field([]),topics:field([]),products:field([]),language:field('unknown')};
const allowed=new Set(['.docx','.pdf','.xlsx','.xls','.csv','.md','.txt','.scenelab-report']);

export class ProjectService {
 constructor(readonly db:Database,readonly knowledge:KnowledgeService,private providerFactory?: (config:LLMConfig)=>LLMProvider) {}
 private async row(id:string,db:Connection=this.db,lock=false) {const row=(await db.query(`SELECT p.* FROM projects p WHERE p.id=$1 AND ${scope}${lock?' FOR UPDATE':''}`,[id]))[0];if(!row)throw new HttpError(404,'项目不存在');return row;}
 private inputRecord(row:any):ProjectInput{return {id:row.id,projectId:row.project_id,documentId:row.document_id||undefined,kind:row.kind,filename:row.filename,title:row.title,status:row.status,createdAt:date(row.created_at),warnings:row.warnings||[],error:row.error||undefined};}
 private assetRecord(row:any):ProjectAsset{return {id:row.id,projectId:row.project_id,inputId:row.input_id,role:row.role,filename:row.filename,mimeType:row.mime_type,objectKey:row.object_key,width:row.width||undefined,height:row.height||undefined,caption:row.caption||undefined,sourceRef:row.source_ref,url:`/api/projects/${row.project_id}/assets/${row.id}`};}
 async list(){const rows=await this.db.query(`SELECT p.id FROM projects p WHERE ${scope} ORDER BY p.updated_at DESC,p.id LIMIT 500`);const items=[];for(const row of rows)items.push(await this.get(row.id));return items;}
 async get(id:string):Promise<Project>{const row=await this.row(id);const inputs=await this.db.query('SELECT * FROM project_inputs WHERE project_id=$1 ORDER BY created_at,id',[id]);const assets=await this.db.query('SELECT * FROM project_assets WHERE project_id=$1 ORDER BY id',[id]);return {id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,name:row.name,customerName:row.customer_name||undefined,description:row.description,companyName:row.company_name,documentType:row.document_type,status:row.status,contextRevision:row.context_revision,confirmedRevision:row.confirmed_revision,createdAt:date(row.created_at),updatedAt:date(row.updated_at),inputs:inputs.map(row=>this.inputRecord(row)),assets:assets.map(row=>this.assetRecord(row))};}
 async create(input:{name:string;customerName?:string;description?:string;companyName?:string}) {
  const id=randomUUID();await this.db.query("INSERT INTO projects(id,organization_id,workspace_id,name,customer_name,description,company_name) VALUES($1,'default','default',$2,$3,$4,$5)",[id,input.name.trim(),input.customerName?.trim()||null,input.description||'',input.companyName?.trim()||'上海青瞳视觉科技有限公司']);
  await this.rebuildContext(id);return this.get(id);
 }
 async update(id:string,input:{name?:string;customerName?:string;description?:string;companyName?:string;status?:'archived'|'draft'}) {
  await this.db.transaction(async tx=>{const previous=await this.row(id,tx,true);await tx.query('UPDATE projects SET name=$2,customer_name=$3,description=$4,company_name=$5,status=$6,input_revision=input_revision+1,confirmed_revision=NULL,updated_at=now() WHERE id=$1',[id,input.name??previous.name,input.customerName??previous.customer_name,input.description??previous.description,input.companyName??previous.company_name,input.status??'draft']);await this.audit(tx,id,'project_update',previous,input);});
  if(input.status!=='archived')await this.rebuildContext(id);return this.get(id);
 }
 private async audit(tx:Connection,id:string,action:string,previous:unknown,next:unknown){await tx.query('INSERT INTO project_audit_events(id,project_id,action,previous_value,next_value) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[randomUUID(),id,action,JSON.stringify(previous),JSON.stringify(next)]);}

 async addText(id:string,input:{title?:string;text:string}) {return this.addInput(id,{filename:`${(input.title||'手工补充').replace(/[\\/:*?"<>|]/g,'_').slice(0,150)}.txt`,bytes:Buffer.from(input.text),mimeType:'text/plain',kind:'text',title:input.title});}
 async addInput(id:string,input:{filename:string;bytes:Uint8Array;mimeType?:string;kind?:'text';title?:string}):Promise<{input:ProjectInput;context:ProjectContext}> {
  const project=await this.row(id);if(project.status==='archived')throw new HttpError(409,'归档项目不能导入资料');
  const filename=path.basename(input.filename.replace(/\\/g,'/'));const extension=path.extname(filename).toLowerCase();if(!allowed.has(extension))throw new HttpError(400,'不支持此项目资料格式');if(!input.bytes.length||input.bytes.length>80*1024*1024)throw new HttpError(400,'文件为空或超过 80 MB');
  const hash=createHash('sha256').update(input.bytes).digest('hex'),kind=extension==='.scenelab-report'?'engineering':input.kind||'document';
  const existing=(await this.db.query('SELECT * FROM project_inputs WHERE project_id=$1 AND content_hash=$2 AND kind=$3',[id,hash,kind]))[0];if(existing)return {input:this.inputRecord(existing),context:await this.getContext(id)};
  const inputId=randomUUID(),objectKey=`projects/${id}/inputs/${inputId}/${hash}`;await this.knowledge.storage.put(objectKey,input.bytes);
  let parsed:ParsedDocument|undefined,engineering:EngineeringData|undefined,assets:{asset:ProjectAsset;bytes:Uint8Array}[]=[],warnings:string[]=[],error:string|undefined;
  try {
   if(kind==='engineering'){const result=await new SceneLabReportAdapter().parse(input.bytes,id,inputId,filename);engineering=result.engineering;assets=result.assets;warnings=result.warnings;}
   else {parsed=await parseDocument({buffer:input.bytes,contentHash:hash,meta:{sourceId:'manual',sourceType:'project',filename,mimeType:input.mimeType}});warnings=parsed.parseWarnings;if(parsed.parseStatus==='failed'||!parsed.plainText.trim())throw new HttpError(400,'未能提取正文，请提供可读文档或 OCR 文本');}
  }catch(reason){error=reason instanceof HttpError?reason.message:'项目资料解析失败，请检查格式后重试';}
  for(const asset of assets)await this.knowledge.storage.put(asset.asset.objectKey,asset.bytes);
  const title=input.title||parsed?.title||filename;let committedInputId=inputId;
  await this.db.transaction(async tx=>{
   await this.row(id,tx,true);const concurrent=(await tx.query('SELECT id FROM project_inputs WHERE project_id=$1 AND content_hash=$2 AND kind=$3',[id,hash,kind]))[0];if(concurrent){committedInputId=concurrent.id;return;}
   let documentId:string|undefined;
   if(parsed&&!error){documentId=randomUUID();const versionId=randomUUID(),sourceId=randomUUID();await tx.query("INSERT INTO source_documents(id,source_id,source_document_id,source_path,content_hash) VALUES($1,'manual',$2,$3,$4)",[sourceId,`project:${id}:${inputId}`,filename,hash]);
    await tx.query("INSERT INTO documents(id,organization_id,workspace_id,scope,project_id,source_document_id,title,canonical_title,status,active_version_id) VALUES($1,'default','default','project',$2,$3,$4,$4,'active',$5)",[documentId,id,sourceId,title,versionId]);
    await tx.query("INSERT INTO document_versions(id,document_id,version_number,filename,mime_type,content_hash,normalized_content_hash,object_key,size_bytes,parsed_document,parse_status,summary,extractive_summary) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11)",[versionId,documentId,filename,input.mimeType||null,hash,normalizedContentHash(parsed),objectKey,input.bytes.length,JSON.stringify(parsed),parsed.parseStatus,extractiveSummary(parsed.plainText)]);
    for(const [name,value] of Object.entries(classification))await tx.query('INSERT INTO classification_results(version_id,field,value,confidence,source) VALUES($1,$2,$3::jsonb,$4,$5)',[versionId,name,JSON.stringify(value.value),value.confidence,value.source]);
    for(const chunk of chunkDocument(parsed,classification,{targetTokens:1000,overlapTokens:80}))await tx.query("INSERT INTO knowledge_chunks(id,document_id,version_id,chunk_order,heading_path,text,summary,metadata,search_vector) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,to_tsvector('simple',$9))",[randomUUID(),documentId,versionId,chunk.order,JSON.stringify(chunk.headingPath),chunk.text,chunk.summary,JSON.stringify({...chunk.metadata,sourceInputId:inputId,scope:'project',projectId:id}),indexText(`${title} ${chunk.text}`)]);
   }
   await tx.query('INSERT INTO project_inputs(id,project_id,document_id,kind,filename,title,content_hash,object_key,mime_type,status,parsed_document,engineering_data,warnings,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)',[inputId,id,documentId||null,kind,filename,title,hash,objectKey,input.mimeType||null,error?'failed':'ready',JSON.stringify(parsed||null),JSON.stringify(engineering||null),JSON.stringify(warnings),error||null]);
   for(const {asset} of assets)await tx.query('INSERT INTO project_assets(id,project_id,input_id,role,filename,mime_type,object_key,width,height,caption,source_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',[asset.id,id,inputId,asset.role,asset.filename,asset.mimeType,asset.objectKey,asset.width,asset.height,asset.caption||null,JSON.stringify(asset.sourceRef)]);
   await tx.query("UPDATE projects SET input_revision=input_revision+1,confirmed_revision=NULL,status='draft',updated_at=now() WHERE id=$1",[id]);
   await this.audit(tx,id,'project_input_added',null,{inputId,filename,kind,status:error?'failed':'ready'});
  });
  const context=await this.rebuildContext(id);const row=(await this.db.query('SELECT * FROM project_inputs WHERE id=$1 AND project_id=$2',[committedInputId,id]))[0];return {input:this.inputRecord(row),context};
 }

 async queryChunks(projectId:string,query:string,limit=8,sourceIds?:string[]) {
  await this.row(projectId);const text=queryText(query,'or');
  const rows=await this.db.query(`SELECT c.id,c.document_id,c.version_id,c.text,d.title,i.id AS input_id,CASE WHEN $2='' THEN 0 ELSE ts_rank_cd(c.search_vector,to_tsquery('simple',$2)) END AS score
   FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id JOIN project_inputs i ON i.document_id=d.id AND i.project_id=d.project_id
   WHERE d.organization_id='default' AND d.workspace_id='default' AND d.scope='project' AND d.project_id=$1 AND d.status='active' AND d.canonical_document_id IS NULL
    AND c.version_id=d.active_version_id AND i.status='ready' AND ($2='' OR c.search_vector @@ to_tsquery('simple',$2))
    AND ($4::text[] IS NULL OR c.id=ANY($4::text[]) OR d.id=ANY($4::text[]) OR i.id=ANY($4::text[]))
   ORDER BY score DESC,c.id LIMIT $3`,[projectId,text,Math.max(1,Math.min(30,limit)),sourceIds?.length?sourceIds:null]);
  const seen=new Set<string>();return rows.filter(row=>{const key=createHash('sha256').update(row.text.replace(/\s+/g,' ').trim()).digest('hex');if(seen.has(key))return false;seen.add(key);return true;}).map(row=>({id:row.id,documentId:row.document_id,versionId:row.version_id,title:row.title,text:row.text,sourceInputId:row.input_id,score:Number(row.score)}));
 }
 async downloadAsset(projectId:string,assetId:string){await this.row(projectId);const row=(await this.db.query('SELECT * FROM project_assets WHERE id=$1 AND project_id=$2',[assetId,projectId]))[0];if(!row)throw new HttpError(404,'项目图片不存在');return {asset:this.assetRecord(row),bytes:await this.knowledge.storage.get(row.object_key)};}
 async downloadInput(projectId:string,inputId:string){await this.row(projectId);const row=(await this.db.query('SELECT * FROM project_inputs WHERE id=$1 AND project_id=$2',[inputId,projectId]))[0];if(!row)throw new HttpError(404,'项目资料不存在');return {input:this.inputRecord(row),mimeType:row.mime_type||'application/octet-stream',bytes:await this.knowledge.storage.get(row.object_key)};}
 async getContext(id:string):Promise<ProjectContext>{const project=await this.row(id);const row=(await this.db.query('SELECT context,confirmed_at FROM project_context_snapshots WHERE project_id=$1 AND revision=$2',[id,project.context_revision]))[0];if(!row)throw new HttpError(409,'项目上下文尚未生成');return {...row.context,confirmed:project.confirmed_revision===project.context_revision&&row.context.inputRevision===project.input_revision,confirmedAt:row.confirmed_at?date(row.confirmed_at):undefined};}

 private async sources(id:string):Promise<RequirementSource[]>{const rows=await this.db.query("SELECT id,document_id,parsed_document FROM project_inputs WHERE project_id=$1 AND status='ready' AND kind IN ('document','text') ORDER BY created_at,id",[id]);const result=[];for(const row of rows){const chunks=await this.db.query('SELECT c.id,c.text FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id WHERE d.id=$1 AND d.project_id=$2 AND d.scope=\'project\' AND c.version_id=d.active_version_id ORDER BY c.chunk_order',[row.document_id,id]);result.push({id:row.id,text:row.parsed_document?.plainText||'',chunks:chunks as {id:string;text:string}[]});}return result;}
 private async legacyEngineering(id:string){
  const rows=await this.db.query("SELECT id,filename,object_key,engineering_data,warnings FROM project_inputs WHERE project_id=$1 AND kind='engineering' AND status='ready' ORDER BY created_at,id",[id]);
  const upgrades=[];
  for(const row of rows){if(Number(row.engineering_data?.metadata?.adapterVersion)>=2)continue;
   const parsed=await new SceneLabReportAdapter().parse(await this.knowledge.storage.get(row.object_key),id,row.id,row.filename);
   // Existing assets are immutable references used by older contexts, documents and cover logos.
   const assets=await this.db.query('SELECT * FROM project_assets WHERE project_id=$1 AND input_id=$2 ORDER BY id',[id,row.id]);parsed.engineering.assets=assets.map(asset=>this.assetRecord(asset));
   upgrades.push({id:row.id,previous:row.engineering_data,engineering:parsed.engineering,warnings:[...new Set([...(row.warnings||[]),...parsed.warnings])]});
  }return upgrades;
 }
 async rebuildContext(id:string,options:{useAI?:boolean}&RequirementExtractionOptions={}):Promise<ProjectContext> {
  const project=await this.row(id),sources=await this.sources(id),upgrades=await this.legacyEngineering(id);let requirements=parseRequirements(sources);
  if(options.useAI){if(!sources.length)throw new HttpError(400,'请先导入客户需求资料');const config=await this.knowledge.settings.config();if(!config||!this.providerFactory)throw new HttpError(400,'请先配置模型');
   const model=options.model||'kimi-k3';let host='';try{const url=new URL(config.baseUrl);if(url.protocol==='https:')host=url.hostname;}catch{/* rejected below */}
   if(host!=='api.moonshot.cn'||!['kimi-k3','kimi-k2.6'].includes(model))throw new HttpError(400,'项目需求提取当前支持 Moonshot.cn 的 kimi-k3、kimi-k2.6');
   const profile=modelProfile(model),limitsEnabled=options.limitsEnabled===true,requests=buildRequirementRequests(sources,{limitsEnabled,model}),maxTokens=limitsEnabled?4000:profile.defaultOutputTokens;
   const inputBytes=requests.reduce((sum,item)=>sum+item.inputBytes,0),reservation=requests.reduce((sum,item)=>sum+estimatedModelCost(model,item.inputBytes+1024,maxTokens)*3,0),requestId=randomUUID();
   // Keep the shared usage ledger even when the optional application budget is disabled.
   await this.db.transaction(async tx=>{await this.row(id,tx,true);await tx.query("INSERT INTO settings(key,value) VALUES('projectExtractionBudget','{\"reservedCny\":0}'::jsonb) ON CONFLICT DO NOTHING");const budget=(await tx.query("SELECT value FROM settings WHERE key='projectExtractionBudget' FOR UPDATE"))[0].value;const prior=Number(budget.reservedCny)||0;if(limitsEnabled&&prior+reservation>25)throw new HttpError(409,'项目需求提取累计预算已达到 25 元上限；可关闭额度限制后继续');await tx.query("UPDATE settings SET value=$1::jsonb,updated_at=now() WHERE key='projectExtractionBudget'",[JSON.stringify({reservedCny:prior+reservation})]);await this.audit(tx,id,'requirement_extraction_reserved',{reservedCny:prior},{requestId,inputBytes,maxOutputTokens:maxTokens,reservedCny:reservation,totalReservedCny:prior+reservation,model,retryAllowance:3,limitsEnabled,batchCount:requests.length});});
   // Extraction runs only on an explicit request. Failures retain reservations and the previous context.
   try{requirements=await extractRequirementsAI(sources,this.providerFactory({...config,model,temperature:profile.temperature,maxTokens,requestTimeoutMs:profile.requestTimeoutMs,reasoningEffort:model==='kimi-k3'?'max':undefined}),async(response,bytes)=>{await this.audit(this.db,id,'requirement_extraction_usage',null,{requestId,inputBytes:bytes,model,usage:response.usage||null});},{limitsEnabled,model});}catch{throw new HttpError(502,'需求提取未完成，原项目事实未改动；用量预留已保留以覆盖可能已发生的请求');}
  }
  return this.db.transaction(async tx=>{
   const current=await this.row(id,tx,true);if(current.context_revision!==project.context_revision||current.input_revision!==project.input_revision)throw new HttpError(409,'项目资料已变化，请重新提取');
   for(const upgrade of upgrades){const updated=await tx.query('UPDATE project_inputs SET engineering_data=$3::jsonb,warnings=$4::jsonb WHERE id=$1 AND project_id=$2 AND engineering_data=$5::jsonb RETURNING id',[upgrade.id,id,JSON.stringify(upgrade.engineering),JSON.stringify(upgrade.warnings),JSON.stringify(upgrade.previous)]);if(!updated.length)throw new HttpError(409,'工程报告适配结果已更新，请重新提取');await this.audit(tx,id,'engineering_adapter_upgraded',{inputId:upgrade.id,adapterVersion:upgrade.previous?.metadata?.adapterVersion??1},{inputId:upgrade.id,adapterVersion:2});}
   const previous=(await tx.query('SELECT context FROM project_context_snapshots WHERE project_id=$1 AND revision=$2',[id,current.context_revision]))[0]?.context as ProjectContext|undefined;
   // Explicit user corrections survive another import or extraction.
   if(previous?.reviewedInputIds?.length){
    const reviewed=new Set(previous.reviewedInputIds);
    for(const key of ['goals','interfaces','protocols','environment','installationConstraints','specialRequirements','acceptanceCriteria'] as const)requirements[key]=requirements[key].filter(item=>!reviewed.has(item.sourceInputId));
    for(const [key,item] of Object.entries(requirements.performance))if(item&&reviewed.has(item.sourceInputId))delete requirements.performance[key as keyof ProjectRequirements['performance']];
   }
   if(previous)for(const [category,item] of requirementEntries(previous.requirements).filter(([,item])=>item.confirmedByUser)){
    if(category.startsWith('performance.'))requirements.performance[category.slice(12) as keyof ProjectRequirements['performance']]=item;
    else {const key=category as 'goals';requirements[key]=requirements[key].filter(existing=>existing.id!==item.id);requirements[key].push(item);}
   }
   requirements.projectName=current.name;requirements.customerName=current.customer_name||undefined;requirements.unresolved=requirementQuestions(requirements);
   const input=(await tx.query("SELECT engineering_data FROM project_inputs WHERE project_id=$1 AND kind='engineering' AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 1",[id]))[0];
   const engineering=input?.engineering_data as EngineeringData|undefined;
   const context:ProjectContext={projectId:id,revision:current.context_revision+1,inputRevision:current.input_revision,confirmed:false,summary:current.description||`${current.name}${current.customer_name?`；客户：${current.customer_name}`:''}`,requirements,engineering,lockedFacts:[],products:engineering?.deployment?.models?.map(model=>model.name)||[],capabilities:[],assets:engineering?.assets||[],conflicts:[],unresolved:requirements.unresolved};
   context.reviewedInputIds=previous?.reviewedInputIds;
   const userFacts=await tx.query("SELECT * FROM project_facts WHERE project_id=$1 AND source_type='user'",[id]);context.lockedFacts=userFacts.map(row=>({id:row.id,key:row.key,label:row.label,value:row.value,unit:row.unit||undefined,sourceType:'user',sourceRef:row.source_ref,locked:true}));
   const selectedProducts=context.lockedFacts.find(fact=>fact.key==='products');if(selectedProducts&&Array.isArray(selectedProducts.value))context.products=selectedProducts.value as string[];
   const userSummary=context.lockedFacts.find(fact=>fact.key==='project.summary');if(userSummary&&typeof userSummary.value==='string')context.summary=userSummary.value;
   await this.derive(context,tx);return this.persistContext(tx,current,context,'context_rebuilt');
  });
 }

 private async derive(context:ProjectContext,tx:Connection) {
  const user=context.lockedFacts.filter(fact=>fact.sourceType==='user');const facts:LockedFact[]=[];const conflicts:ProjectConflict[]=[];
  const add=(key:string,label:string,value:unknown,unit:string|undefined,sourceType:LockedFact['sourceType'],sourceRef:SourceReference)=>{if(value!==undefined&&value!==null)facts.push({id:stableId(context.projectId,sourceType,key),key,label,value,unit,sourceType,sourceRef,locked:true});};
  for(const [category,item] of requirementEntries(context.requirements))add(`requirement.${category}.${item.id}`,category,item.value,undefined,'customer_requirement',{type:item.sourceInputId==='user'?'user':'project_input',id:item.sourceInputId,label:category,evidence:item.evidence});
  const engineering=context.engineering;context.capabilities=[];
  if(engineering){const ref=engineering.sourceRef;add('scene.boundaryM','场地尺寸',engineering.scene?.boundaryM,'m','engineering_data',ref);add('deployment.equipmentCount','相机数量',engineering.deployment?.equipmentCount,'台','engineering_data',ref);add('deployment.models','相机型号与数量',engineering.deployment?.models,undefined,'engineering_data',ref);
   if(engineering.deployment?.opticalConfigurations?.length)add('engineering.opticalConfigurations','原报告工程仿真光学配置',engineering.deployment.opticalConfigurations,undefined,'engineering_data',ref);
   const labels:Record<string,string>={coverageGe1:'至少1视点覆盖率',coverageGe2:'至少2视点覆盖率',coverageGe3:'至少3视点覆盖率',coverageGe4:'至少4视点覆盖率',coverageGe5:'至少5视点覆盖率',averageViewCount:'平均可见视点数',meanErrorMm:'平均理论定位误差',p90ErrorMm:'P90理论定位误差',p95ErrorMm:'P95理论定位误差',under03Mm:'理论误差≤0.3mm比例',under05Mm:'理论误差≤0.5mm比例'};
   for(const [key,value] of Object.entries(engineering.performance||{})){const unit=key.startsWith('coverage')||key.startsWith('under')?'%':key.endsWith('Mm')?'mm':undefined;add(`performance.${key}`,labels[key]||key,value,unit,'engineering_data',ref);if(value!==null&&value!==undefined)context.capabilities.push({key,label:labels[key]||key,value,unit,sourceRef:ref});}
   const accuracy=context.requirements.performance.accuracy;const actual=engineering.performance?.p95ErrorMm;
   if(accuracy&&actual!=null){const text=typeof accuracy.value==='string'?accuracy.value:String(accuracy.value);const match=text.match(/(?:≤|<=|不超过|不大于|小于等于|小于|低于|<)\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?/i);if(match){const limit=Number(match[1])*(/^(?:cm|厘米)$/i.test(match[2]||'')?10:/^(?:m|米)$/i.test(match[2]||'')?1000:1);if(actual>limit)conflicts.push({id:stableId(context.projectId,'accuracy',String(limit),String(actual)),key:'accuracy',severity:'error',message:`客户要求 ${text}；工程 P95 理论误差为 ${actual} mm。两者存在差异，且须确认指标口径，不能声明已满足要求。`,requirement:accuracy,actual,sourceRefs:[{type:'project_input',id:accuracy.sourceInputId,label:'客户精度要求',evidence:accuracy.evidence},ref],status:'open'});}}
  }
  // User facts take precedence only for the same fact key; customer targets remain separate from capabilities.
  if(engineering)for(const fact of user){const [group,key]=fact.key.split('.');const original=(engineering as any)[group]?.[key];if(original!==undefined&&JSON.stringify(original)!==JSON.stringify(fact.value))conflicts.push({id:stableId(context.projectId,'engineering-override',fact.key),key:fact.key,severity:'warning',message:`用户确认的${fact.label}与原工程报告不同。正文采用用户确认值，工程图片仍来自原报告，请核对或更新工程报告。`,actual:original,sourceRefs:[fact.sourceRef,engineering.sourceRef],status:'open'});}
  context.lockedFacts=[...facts.filter(fact=>!user.some(prior=>prior.key===fact.key)),...user];context.conflicts=conflicts;
  if(engineering?.deployment?.opticalConfigurations?.length){
   // Reuse exact, active authoritative product retrieval on this transaction connection.
   const structured=new StructuredService({...this.db,query:tx.query.bind(tx)});
   context.conflicts.push(...engineeringOpticsConflicts(context,await structured.productFacts(context.products)));
  }
  context.unresolved=context.requirements.unresolved.filter(question=>!question.resolved);
 }
 private async persistContext(tx:Connection,project:any,context:ProjectContext,action:string) {
  await tx.query('INSERT INTO project_context_snapshots(id,project_id,revision,context) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),project.id,context.revision,JSON.stringify(context)]);
  await tx.query("UPDATE projects SET context_revision=$2,confirmed_revision=NULL,status=CASE WHEN status='archived' THEN status ELSE 'draft' END,updated_at=now() WHERE id=$1",[project.id,context.revision]);
  await tx.query("DELETE FROM project_facts WHERE project_id=$1 AND source_type<>'user'",[project.id]);
  for(const fact of context.lockedFacts)await tx.query('INSERT INTO project_facts(id,project_id,key,label,value,unit,source_type,source_ref,locked) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,true) ON CONFLICT(project_id,key,source_type) DO UPDATE SET label=excluded.label,value=excluded.value,unit=excluded.unit,source_ref=excluded.source_ref,updated_at=now()',[fact.id,project.id,fact.key,fact.label,JSON.stringify(fact.value),fact.unit||null,fact.sourceType,JSON.stringify(fact.sourceRef)]);
  await tx.query('DELETE FROM project_requirements WHERE project_id=$1',[project.id]);
  for(const [category,item] of requirementEntries(context.requirements))await tx.query('INSERT INTO project_requirements(id,project_id,category,source_input_id,source_chunk_id,item) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO UPDATE SET category=excluded.category,item=excluded.item,updated_at=now()',[item.id,project.id,category,item.sourceInputId==='user'?null:item.sourceInputId,item.sourceChunkId||null,JSON.stringify(item)]);
  await this.audit(tx,project.id,action,{revision:project.context_revision},{revision:context.revision});return context;
 }
 async patchContext(id:string,input:ContextPatch):Promise<ProjectContext> {
  for(const fact of input.facts??[]){
   if(fact.value===undefined||JSON.stringify(fact.value).length>10000)throw new HttpError(400,'项目事实为空或过长');
   if(fact.key==='scene.boundaryM'&&(!Array.isArray(fact.value)||fact.value.length!==3||fact.value.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0)||fact.unit&&fact.unit!=='m'))throw new HttpError(400,'场地尺寸须为三个正数，单位 m');
   if(fact.key==='deployment.equipmentCount'&&(!Number.isInteger(fact.value)||Number(fact.value)<0||Number(fact.value)>10000||fact.unit&&fact.unit!=='台'))throw new HttpError(400,'设备数量须为 0–10000 的整数，单位台');
   if(fact.key==='deployment.models'&&(!Array.isArray(fact.value)||fact.value.length>100||fact.value.some(v=>!v||typeof v.name!=='string'||!v.name.trim()||!Number.isInteger(v.count)||v.count<0)))throw new HttpError(400,'设备型号需填写 [{"name":"K18","count":16}] 形式的配置');
   if(fact.key.startsWith('performance.')&&(typeof fact.value!=='number'||!Number.isFinite(fact.value)||fact.value<0||/coverage|under/.test(fact.key)&&fact.value>100))throw new HttpError(400,'性能事实须为有效非负数，百分比为 0–100');
  }
  return this.db.transaction(async tx=>{const project=await this.row(id,tx,true);if(project.context_revision!==input.revision)throw new HttpError(409,'项目理解已更新，请刷新后编辑');const stored=(await tx.query('SELECT context FROM project_context_snapshots WHERE project_id=$1 AND revision=$2',[id,input.revision]))[0];if(!stored)throw new HttpError(409,'项目上下文不存在');const context=structuredClone(stored.context) as ProjectContext;
   if(context.inputRevision!==project.input_revision)throw new HttpError(409,'存在新导入资料，请重新提取项目理解');
   context.revision++;context.confirmed=false;delete context.confirmedAt;if(input.summary!==undefined){context.summary=input.summary;context.lockedFacts=context.lockedFacts.filter(fact=>!(fact.key==='project.summary'&&fact.sourceType==='user'));context.lockedFacts.push({id:stableId(id,'user','project.summary'),key:'project.summary',label:'项目概述',value:input.summary,sourceType:'user',sourceRef:{type:'user',id,label:'用户确认项目概述',evidence:input.summary},locked:true});}
   if(input.requirements){context.reviewedInputIds=(await tx.query('SELECT id FROM project_inputs WHERE project_id=$1',[id])).map(r=>r.id);const old=new Map(requirementEntries(context.requirements).map(([,item])=>[item.id,item]));context.requirements=input.requirements;for(const [category,item] of requirementEntries(context.requirements)){const original=old.get(item.id);if(!original||JSON.stringify(original.value)!==JSON.stringify(item.value)){item.id=stableId(id,'user-requirement',category,JSON.stringify(item.value));item.sourceInputId='user';delete item.sourceChunkId;item.evidence=`人工确认：${typeof item.value==='string'?item.value:JSON.stringify(item.value)}`;}else{item.sourceInputId=original.sourceInputId;item.sourceChunkId=original.sourceChunkId;item.evidence=original.evidence;}item.confirmedByUser=true;item.confidence=1;}}
   for(const item of input.facts||[]) {const fact:LockedFact={...item,id:stableId(id,'user',item.key),sourceType:'user',sourceRef:{type:'user',id,label:'用户确认项目事实',evidence:`${item.label}：${JSON.stringify(item.value)}`},locked:true};context.lockedFacts=context.lockedFacts.filter(old=>!(old.key===item.key&&old.sourceType==='user'));context.lockedFacts.push(fact);}
   if(input.products){context.products=[...new Set(input.products)];context.lockedFacts=context.lockedFacts.filter(fact=>!(fact.key==='products'&&fact.sourceType==='user'));context.lockedFacts.push({id:stableId(id,'user','products'),key:'products',label:'人工选择产品型号',value:context.products,sourceType:'user',sourceRef:{type:'user',id,label:'用户选择型号',evidence:context.products.join('、')},locked:true});}
   const previousQuestions=new Map(context.requirements.unresolved.map(q=>[q.id,q]));context.requirements.unresolved=requirementQuestions(context.requirements).map(q=>({...q,resolved:previousQuestions.get(q.id)?.resolved||input.resolvedQuestionIds?.includes(q.id)||false}));await this.derive(context,tx);return this.persistContext(tx,project,context,'context_edited');});
 }
 async confirmContext(id:string,revision:number):Promise<ProjectContext> {
  await this.db.transaction(async tx=>{const project=await this.row(id,tx,true);if(project.status==='archived')throw new HttpError(409,'项目已归档');if(project.context_revision!==revision)throw new HttpError(409,'项目资料已更新，请复核最新版本');const row=(await tx.query('SELECT context FROM project_context_snapshots WHERE project_id=$1 AND revision=$2 FOR UPDATE',[id,revision]))[0];if(!row)throw new HttpError(409,'项目上下文不存在');const context=row.context as ProjectContext;
   if(context.inputRevision!==project.input_revision)throw new HttpError(409,'存在新导入资料，请重新提取后确认');
   if(!context.requirements.goals.length&&!requirementEntries(context.requirements).length&&!context.engineering&&!context.lockedFacts.some(f=>f.sourceType==='user')&&!project.description)throw new HttpError(400,'请先补充项目说明、客户资料或项目事实');
   context.confirmed=true;context.confirmedAt=new Date().toISOString();for(const [,item] of requirementEntries(context.requirements))item.confirmedByUser=true;
   context.reviewedInputIds=(await tx.query('SELECT id FROM project_inputs WHERE project_id=$1',[id])).map(r=>r.id);
   await tx.query('UPDATE project_context_snapshots SET context=$3::jsonb,confirmed_at=now() WHERE project_id=$1 AND revision=$2',[id,revision,JSON.stringify(context)]);await tx.query("UPDATE projects SET confirmed_revision=$2,status='context_ready',updated_at=now() WHERE id=$1",[id,revision]);await this.audit(tx,id,'context_confirmed',null,{revision,openConflicts:context.conflicts.length,unresolved:context.unresolved.length});
  });return this.getContext(id);
 }
}
