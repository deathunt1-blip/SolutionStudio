import {describe,expect,it} from 'vitest';
import {validateSections} from '../packages/document-engine/src/validation.js';
import type {DocumentBlock,DocumentSection,SourceRef} from '../packages/document-engine/src/types.js';
import type {LockedFact,ProjectContext,RequirementItem} from '../packages/projects/src/types.js';

const engineeringSource:SourceRef={type:'engineering_data',id:'engineering',label:'工程报告',evidence:'项目工程分析结果'};
const userSource:SourceRef={type:'user',id:'user-confirmation',label:'用户确认',evidence:'人工确认的项目事实'};
const source=(evidence:string,extra:Partial<SourceRef>={}):SourceRef=>({type:'structured_fact',id:'spec',label:'产品规格',evidence,authority:'authoritative',...extra});
const requirement=(key:string,value:string):RequirementItem=>({id:`requirement-${key}`,key,value,sourceInputId:'customer',evidence:`客户要求${value}`,confidence:1,confirmedByUser:true});
const fact=(key:string,value:unknown,unit?:string,label=key):LockedFact=>({id:`fact-${key}`,key,value,unit,label,sourceType:'user',sourceRef:userSource,locked:true});
const context=():ProjectContext=>({projectId:'project',revision:1,confirmed:true,summary:'动作捕捉项目',requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]},lockedFacts:[],products:['K18'],capabilities:[],assets:[],conflicts:[],unresolved:[]});
const engineering=():ProjectContext=>({...context(),engineering:{sourceType:'scenelab',scene:{boundaryM:[20,20,15]},deployment:{equipmentCount:32,models:[{name:'K18',count:32}]},performance:{p95ErrorMm:.35,p90ErrorMm:.3,meanErrorMm:.2,coverageGe3:98.765,under03Mm:92.24,averageViewCount:4.26},assets:[],sourceRef:engineeringSource}});
const section=(blocks:DocumentBlock[],sourceRefs:SourceRef[]=[]):DocumentSection=>({id:'section',title:'技术方案',level:1,order:1,generationMode:'mixed',requiredContext:[],status:'edited',blocks,sourceRefs,assetRefs:[],lockedFactRefs:[],claims:[],revision:1,edited:true});
const check=(text:string,c=context(),refs:SourceRef[]=[])=>validateSections([section([{id:'paragraph',type:'paragraph',text}],refs)],c);
const errors=(text:string,c=context(),refs:SourceRef[]=[])=>check(text,c,refs).filter(issue=>issue.severity==='error');

describe('typed and source-grounded document fact validation',()=>{
 it('checks 36 K18 cameras against 32 locked cameras even without engineering input',()=>{
  const c=context();c.lockedFacts=[fact('deployment.equipmentCount',32,'台','相机数量')];
  const issues=errors('系统配置36台K18相机。',c);
  expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',blockId:'paragraph',quote:'36台',sourceRefs:[userSource]})]));
  expect(errors('系统配置32台K18相机。',c)).toEqual([]);
 });
 it('does not use an unrelated equal number as an accuracy source',()=>{
  const c=context();c.lockedFacts=[fact('performance.latency',.05,'ms','时延')];
  expect(errors('系统定位精度可达0.05mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.05mm'})]));
  expect(errors('系统定位精度可达0.05mm。',context(),[source('视场角 0.05°')])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('does not exchange P95, P90 and mean metrics or erase metric identity',()=>{
  const c=engineering();
  expect(errors('P95理论误差为0.2mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',message:expect.stringContaining('P95')})]));
  expect(errors('平均理论误差为0.35mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',message:expect.stringContaining('平均')})]));
  expect(errors('P95理论误差为0.35mm，平均理论误差为0.2mm。',c)).toEqual([]);
  expect(errors('系统定位精度达到0.35mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('recognizes the mean label when it explicitly describes a positioning error metric',()=>{
  const c=engineering();c.engineering!.performance!.meanErrorMm=.194319106;
  expect(errors('理论定位误差指标：均值0.194mm。',c)).toEqual([]);
  expect(errors('理论定位误差指标：均值0.35mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',message:expect.stringContaining('平均')})]));
 });
 it('allows modest rounding and equivalent units but rejects optimistic zero or full coverage',()=>{
  const c=engineering();c.engineering!.performance!.p95ErrorMm=.346789;
  expect(errors('P95理论误差为0.35mm。至少3视角覆盖率98.77%。',c)).toEqual([]);
  expect(errors('P95理论误差为0.0346789cm。',c)).toEqual([]);
  expect(errors('P95理论误差为0mm。至少3视角覆盖率100%。',c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
 });
 it('keeps customer requirements separate from capabilities, including a mixed sentence',()=>{
  const c=engineering();c.requirements.performance.accuracy=requirement('accuracy','精度≤0.1mm');
  const refs=[source('客户要求精度≤0.1mm',{type:'project_input',id:'customer',authority:'customer_requirement'})];
  expect(errors('客户要求精度≤0.1mm。',c,refs)).toEqual([]);
  expect(errors('系统精度达到0.1mm。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('客户要求精度≤0.1mm，系统精度可达0.05mm。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.05mm'})]));
 });
 it('does not turn a system design objective into a customer requirement',()=>{
  const c=engineering();c.requirements.performance.cameraCount=requirement('cameraCount','40台K18相机');
  expect(errors('同步系统的设计目标为实现32台K18动捕相机在统一时间基准下的协同采集。',c)).toEqual([]);
  expect(errors('本项目设计目标为实现32台K18相机协同采集。',c)).toEqual([]);
  expect(errors('同步系统设计目标为实现36台K18相机协同采集。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'36台'})]));
  expect(errors('客户要求：系统设计目标为实现40台K18相机协同采集。',c)).toEqual([]);
  expect(errors('用户要求：系统设计目标为实现40台K18相机协同采集。',c)).toEqual([]);
  expect(errors('客户要求：系统设计目标为实现32台K18相机协同采集。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'32台'})]));
 });
 it('does not swallow an open conflict after a user fact takes precedence',()=>{
  const c=engineering();c.requirements.performance.accuracy=requirement('accuracy','精度≤0.1mm');
  c.lockedFacts=[fact('performance.p95ErrorMm',.1,'mm','P95理论误差'),fact('deployment.equipmentCount',24,'台','相机数量')];
  c.conflicts=[{id:'conflict',key:'accuracy',severity:'error',message:'客户0.1mm与工程0.35mm口径/数值仍待核实',status:'open',sourceRefs:[engineeringSource,userSource]}];
  expect(errors('本项目配置24台K18相机，P95理论误差为0.1mm。',c)).toEqual([]);
  expect(errors('系统已满足客户0.1mm精度要求。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'requirement_conflict',sourceRefs:[engineeringSource,userSource]})]));
  expect(errors('系统尚未满足客户要求。',c)).toEqual([]);
  expect(errors('是否满足客户要求仍待确认。',c).map(issue=>issue.type)).toEqual(['customer_facing']);
 });
 it('checks manually changed generated table values including units carried by headers',()=>{
  const c=engineering();
  const table:DocumentBlock={id:'table',type:'table',title:'已确认设备配置',columns:['设备型号','数量（台）','配置依据'],rows:[['K18','36','工程报告']],sourceRefs:[engineeringSource],generated:true};
  expect(validateSections([section([table])],c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',blockId:'table',quote:'36台'})]));
  table.rows[0][1]='32';expect(validateSections([section([table])],c)).toEqual([]);
  table.generated=false;table.rows[0][1]='36';expect(validateSections([section([table])],c).some(issue=>issue.type==='fact_mismatch')).toBe(true);
 });
 it('validates generated precision tables rather than trusting their generated flag',()=>{
  const table:DocumentBlock={id:'table',type:'table',title:'理论精度分析结果',columns:['指标','工程报告结果'],rows:[['平均理论误差','0.2mm'],['P95理论误差','0.35mm'],['理论误差 ≤0.3 mm 占比','92.24%']],sourceRefs:[engineeringSource],generated:true};
  expect(validateSections([section([table])],engineering())).toEqual([]);
  table.rows[1][1]='0.2mm';expect(validateSections([section([table])],engineering())).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',message:expect.stringContaining('P95')})]));
 });
 it.each(['系统支持PTP同步。','帧率达到200fps。','FOV为90°。','分辨率为2048×1536像素。'])('rejects unsupported technical claims: %s',text=>{
  expect(errors(text)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('matches metric-specific structured facts and rejects protocol negation or style evidence',()=>{
  const refs=[source('K18 帧率200fps，FOV 90°，分辨率2048×1536像素，支持PTP同步。')];
  expect(errors('帧率达到200fps，FOV为90°，分辨率为2048×1536像素，支持PTP同步。',context(),refs)).toEqual([]);
  expect(errors('支持PTP同步。',context(),[source('不支持PTP同步。')])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('帧率达到200fps。',context(),[source('帧率200fps',{authority:'style_only'})])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('does not turn a requested protocol into a supported protocol',()=>{
  const c=context();c.requirements.protocols=[requirement('protocols','支持PTP同步')];
  expect(errors('客户要求支持PTP同步。',c)).toEqual([]);
  expect(errors('系统支持PTP同步。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('keeps historical projects and normative clauses from certifying current product capabilities',()=>{
  const history=source('K18帧率120fps，支持PTP同步。',{type:'knowledge_chunk',label:'历史客户投标方案',authority:'reference'});
  const standard=source('相机帧率应为120fps，应支持PTP同步。',{type:'knowledge_chunk',label:'光学系统团体标准',authority:'authoritative'});
  for(const ref of [history,standard]){
   expect(errors('本项目K18相机支持120fps，支持PTP同步。',context(),[ref]).filter(issue=>issue.type==='unsupported_claim')).toHaveLength(2);
  }
  expect(check('建议参考标准开展同步设计，具体实现待确认。',context(),[standard]).map(issue=>issue.type)).toEqual(['customer_facing']);
  const mixedManual=source('K18帧率应为120fps。K18应支持PTP同步。',{type:'knowledge_chunk',label:'K18技术手册',authority:'authoritative'});
  expect(errors('K18帧率120fps，支持PTP同步。',context(),[mixedManual]).filter(issue=>issue.type==='unsupported_claim')).toHaveLength(2);
 });
 it('accepts an identified reference manual for the exact selected model while flagging ambiguous sources',()=>{
  const manual=source('K18帧率120fps，支持PTP同步。',{type:'knowledge_chunk',label:'K18技术说明书',authority:'reference'});
  expect(errors('K18帧率120fps，支持PTP同步。',context(),[manual])).toEqual([]);
  expect(errors('相机帧率120fps。',context(),[manual])).toEqual([]);
  expect(errors('K18帧率120fps。',context(),[{...manual,label:'来源不明的片段'}])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('K18帧率120fps。',context(),[{...manual,label:'K180技术手册',evidence:'K180帧率120fps。'}])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('K18帧率120fps。',context(),[{...manual,label:'通用相机技术手册',evidence:'相机帧率120fps。'}])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('K18支持PTP同步。',context(),[{...manual,label:'K1技术手册',evidence:'K1支持PTP同步。'}])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('reads resolution-at-frame-rate specification cells without treating physical dimensions as pixels',()=>{
  const c=context(),ref=source('4608x4096@170fps（52°×48°）/Gigabit Ethernet/RJ45/PoE++',{label:'K18 · 产品规格或简称'});
  expect(errors('K18分辨率4608×4096像素，帧率170fps。',c,[ref])).toEqual([]);
  expect(errors('K18分辨率4608×4000像素。',c,[ref])).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch'})]));
  for(const evidence of ['4608x4096','4608mm×4096mm@170fps','4608x4096x170']){
   expect(errors('K18分辨率4608×4096像素。',c,[{...ref,evidence}])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  }
 });
 it('allows grounded standard quotations as design references without exempting nearby project assertions',()=>{
  const standard=source('完成系统标定后，三维定位精度应不低于1mm。整体系统延迟应≤15ms。',{type:'knowledge_chunk',label:'光学动作捕捉系统团体标准',authority:'authoritative'});
  const boundary='属于行业设计参考指标，不代表本项目已实测达到该水平，也不构成本项目的验收口径。';
  const quotes='标准中“完成系统标定后三维定位精度应不低于1mm”以及“整体延迟应≤15ms”';
  expect(check(quotes+boundary,context(),[standard])).toEqual([]);
  expect(errors(quotes+boundary+'本项目精度达到0.1mm。',context(),[standard])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.1mm'})]));
  expect(errors(quotes+'且本项目精度已达到0.1mm，'+boundary,context(),[standard])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.1mm'})]));
  expect(errors('标准中“精度应不低于1mm且本项目精度已达到0.1mm”'+boundary,context(),[standard])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.1mm'})]));
  expect(errors('标准中“精度应不低于1mm并实现0.1mm”'+boundary,context(),[standard])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.1mm'})]));
  expect(errors('标准中“延迟应≤1ms”'+boundary,context(),[standard])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'1ms'})]));
  expect(errors(quotes+boundary,context(),[]).some(issue=>issue.type==='unsupported_claim')).toBe(true);
  expect(errors('本项目精度达到1mm，整体延迟≤15ms。',context(),[standard]).filter(issue=>issue.type==='unsupported_claim')).toHaveLength(2);
 });
 it('keeps selected simulation optics separate from the same model generic product specifications',()=>{
  const c=engineering();c.lockedFacts=[fact('engineering.opticsSource','report')];
  c.engineering!.deployment!.opticalConfigurations=[{model:'K18',variant:'K18_8mm',lens:{focalLengthMm:8},hfovDeg:70,vfovDeg:55,maxWorkingDistanceM:47,rangeMode:'custom',cameraIds:['camera-1'],sourceRef:engineeringSource}];
  const refs=[source('K18视场角52°×48°，镜头焦距12mm，追踪距离30m。',{label:'K18 通用产品规格'})];
  expect(errors('报告仿真水平视场角70°，报告仿真垂直视场角55°，报告配置镜头焦距8mm，仿真最大距离47m。',c,refs)).toEqual([]);
  expect(errors('通用产品参数视场角52°，产品规格镜头焦距12mm，产品标称追踪距离30m。',c,refs)).toEqual([]);
  expect(errors('本次设计采用8mm镜头。',c,refs)).toEqual([]);
  expect(errors('报告仿真视场角52°，通用产品参数视场角70°。',c,refs).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  expect(errors('报告仿真水平视场角55°，报告仿真垂直视场角70°。',c,refs).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  expect(errors('报告配置镜头焦距12mm，通用产品参数镜头焦距8mm。',c,refs).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  expect(errors('报告仿真最大距离30m，通用产品追踪距离47m。',c,refs).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  expect(check('视场角为70°。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({severity:'warning',message:expect.stringContaining('口径')})]));
 });
 it('does not certify physical tracking performance or site dimensions using a simulated working distance',()=>{
  const c=engineering();c.lockedFacts=[fact('engineering.opticsSource','report')];
  c.engineering!.deployment!.opticalConfigurations=[{model:'K18',lens:{focalLengthMm:8},maxWorkingDistanceM:47,cameraIds:['camera-1'],sourceRef:engineeringSource}];
  const refs=[source('K18追踪距离30m。')];
  expect(errors('报告配置已验证追踪距离47m。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'47m'})]));
  expect(errors('相机实际追踪能力47m。',c,[])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'47m'})]));
  for(const value of [30,47])expect(errors(`场地长度${value}m。`,c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:`${value}m`})]));
  expect(errors('系统定位精度8mm。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'8mm'})]));
  const unselected=structuredClone(c);unselected.lockedFacts=[];
  expect(check('采用8mm镜头。',unselected,refs)).toEqual(expect.arrayContaining([expect.objectContaining({severity:'warning',message:expect.stringContaining('口径')})]));
 });
 it('uses the nearest FOV axis in a single optical configuration sentence',()=>{
  const c=engineering();c.lockedFacts=[fact('engineering.opticsSource','report')];
  c.engineering!.deployment!.opticalConfigurations=[{model:'K18',lens:{focalLengthMm:8,apertureF:1.4},hfovDeg:72,vfovDeg:67,cameraIds:['camera-1'],sourceRef:engineeringSource}];
  const prefix='报告仿真光学配置为K18 Standard、8mm焦距、F1.4光圈、';
  expect(errors(prefix+'水平视场角72°、垂直视场角67°。',c)).toEqual([]);
  expect(errors(prefix+'垂直视场角67°、水平视场角72°。',c)).toEqual([]);
  expect(errors(prefix+'水平视场角67°、垂直视场角72°。',c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
 });
 it('never promotes an unlabeled millimeter value in a user summary to accuracy evidence',()=>{
  const c=context();c.lockedFacts=[fact('project.summary','采用报告8mm光学配置',undefined,'项目摘要')];
  const refs=[source('K18定位精度0.1mm。')];
  expect(errors('K18定位精度0.1mm。',c,refs)).toEqual([]);
  expect(errors('K18定位精度8mm。',c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'8mm',sourceRefs:refs})]));
  expect(errors('K18定位精度8mm。',c,[])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'8mm'})]));
  c.lockedFacts=[fact('performance.accuracy',.2,'mm','定位指标')];
  expect(errors('定位精度0.2mm。',c)).toEqual([]);
  c.lockedFacts=[fact('performance.p95ErrorMm',.3,'mm','P95')];
  expect(errors('P95理论误差0.3mm。',c)).toEqual([]);
 });
 it('recognizes explicit report millimeter optical configurations as focal length',()=>{
  const c=engineering();c.lockedFacts=[fact('engineering.opticsSource','report')];
  c.engineering!.deployment!.opticalConfigurations=[{model:'K18',lens:{focalLengthMm:8},cameraIds:['camera-1'],sourceRef:engineeringSource}];
  for(const text of ['采用报告8mm光学配置。','采用报告 8mm 配置。','本次设计使用8mm镜头。'])expect(check(text,c)).toEqual([]);
  expect(errors('采用报告12mm光学配置。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',message:expect.stringContaining('镜头焦距'),quote:'12mm'})]));
  c.lockedFacts.push(fact('project.summary','采用报告8mm光学配置',undefined,'项目摘要'));
  expect(errors('系统定位精度8mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'8mm'})]));
 });
 it('binds each same-clause accuracy statistic to its nearest explicit label',()=>{
  const c=engineering();c.engineering!.performance!.meanErrorMm=.194;c.engineering!.performance!.p90ErrorMm=.386;c.engineering!.performance!.p95ErrorMm=.492;
  expect(errors('平均理论误差0.194mm、P95理论误差0.492mm。',c)).toEqual([]);
  expect(errors('P95理论误差0.492mm、平均理论误差0.194mm、P90理论误差0.386mm。',c)).toEqual([]);
  expect(errors('平均理论误差0.492mm、P95理论误差0.194mm。',c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  expect(errors('平均理论误差0.194mm、定位精度0.492mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'0.492mm'})]));
  const forced=context();forced.lockedFacts=[fact('performance.p95ErrorMm',.3,'mm','平均值口径另行说明')];
  expect(errors('P95理论误差0.3mm。',forced)).toEqual([]);
 });
 it('validates engineering optics and original product tables against their own scopes',()=>{
  const c=engineering();c.lockedFacts=[fact('engineering.opticsSource','report')];
  c.engineering!.deployment!.opticalConfigurations=[{model:'K18',variant:'K18_8mm',lens:{focalLengthMm:8},hfovDeg:70,vfovDeg:55,maxWorkingDistanceM:47,cameraIds:['camera-1'],sourceRef:engineeringSource}];
  const refs=[source('K18视场角52°×48°，镜头焦距12mm，追踪距离30m。',{label:'K18 通用产品规格'})];
  const optics:DocumentBlock={id:'optics',type:'table',title:'工程报告仿真光学配置',columns:['报告型号','镜头焦距','仿真水平视场角','仿真垂直视场角','仿真最大距离'],rows:[['K18_8mm','8mm','70°','55°','47m']],sourceRefs:[engineeringSource],generated:true};
  const products:DocumentBlock={id:'products',type:'table',title:'权威产品参数',columns:['产品型号','参数','规格'],rows:[['K18','视场角','52°×48°'],['K18','镜头焦距','12mm'],['K18','追踪距离','30m']],sourceRefs:refs,generated:true};
  expect(validateSections([section([optics,products])],c)).toEqual([]);
  optics.rows[0][4]='30m';products.rows[2][2]='47m';
  expect(validateSections([section([optics,products])],c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
 });
 it.each([
  ['帧率','200fps','100fps'],
  ['FOV','90°','60°'],
  ['时延','5ms','10ms'],
  ['精度','0.1mm','0.2mm'],
  ['分辨率','2048×1536像素','1920×1080像素'],
 ])('keeps %s evidence attached to its product model',(metric,k18,k1)=>{
  const c=context();c.products=['K18','K1'];
  const refs=[source(`K18 ${metric}：${k18}`,{id:'k18'}),source(`K1 ${metric}：${k1}`,{id:'k1'})];
  expect(errors(`K18 ${metric}为${k18}。K1 ${metric}为${k1}。`,c,refs)).toEqual([]);
  expect(errors(`K18 ${metric}为${k1}。`,c,refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch'})]));
  expect(errors(`K18 ${metric}为${k1}。`,c,[refs[1]])).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('binds several model specifications within one sentence and table to their own sources',()=>{
  const c=context();c.products=['K18','K1'];
  const refs=[source('K18 帧率200fps',{id:'k18'}),source('K1 帧率100fps',{id:'k1'})];
  expect(errors('K18帧率200fps和K1帧率100fps。',c,refs)).toEqual([]);
  expect(errors('K18帧率100fps和K1帧率200fps。',c,refs).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
  const table:DocumentBlock={id:'table',type:'table',title:'权威产品参数',columns:['产品型号','参数','规格'],rows:[['K18','帧率','100fps'],['K1','帧率','200fps']],sourceRefs:refs,generated:true};
  expect(validateSections([section([table])],c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
 });
 it('uses the product in a structured source label and never accepts a model solely for a matching value',()=>{
  const refs=[source('帧率200fps',{id:'k18',label:'K18 · 帧率'}),source('K1 帧率200fps',{id:'k1'})];
  expect(errors('K18帧率200fps。',context(),refs)).toEqual([]);
  expect(errors('K1帧率200fps。',context(),refs)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'K1'})]));
  const c=context();c.lockedFacts=[fact('deployment.equipmentCount',32,'台','相机数量')];
  expect(errors('系统配置32台K18相机。',c)).toEqual([]);
  expect(errors('系统配置32台K1相机。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'K1'})]));
 });
 it('checks confirmed geometry and model-specific camera allocations',()=>{
  const c=engineering();c.products=['K18','K22'];c.engineering!.deployment={equipmentCount:32,models:[{name:'K18',count:20},{name:'K22',count:12}]};
  expect(errors('配置20台K18相机，配备12台K22相机，场地尺寸20×20×15m。',c)).toEqual([]);
  expect(errors('配置32台K18相机，场地尺寸20×20×18m。',c).filter(issue=>issue.type==='fact_mismatch')).toHaveLength(2);
 });
 it('reads dimensions with a unit on each axis as one geometry tuple',()=>{
  const c=engineering();c.engineering!.scene!.boundaryM=[12,10,5];
  expect(errors('场地尺寸为12 m × 10 m × 5 m。',c)).toEqual([]);
  expect(errors('采用12m×10m×5m的空间。',c)).toEqual([]);
  expect(errors('分析对象为12 m × 10 m × 5 m场地内配置32台K18相机的部署方案。',c)).toEqual([]);
  expect(errors('系统采用32台K18相机部署于12m×10m×5m场地。',c)).toEqual([]);
  expect(errors('场地尺寸为1200 cm × 10000 mm × 5 m。',c)).toEqual([]);
  expect(errors('场地尺寸为12 m × 10 m × 6 m。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'12 m × 10 m × 6 m'})]));
  expect(errors('场地尺寸为12 cm × 10 m × 5 m。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch'})]));
 });
 it('does not read an underscored report revision as a camera model',()=>{
  const c=engineering();c.engineering!.sourceRef={...engineeringSource,label:'K18Fixture_case_R31.scenelab-report'};
  expect(errors('依据K18Fixture_case_R31.scenelab-report配置32台K18相机。',c)).toEqual([]);
  expect(errors('P95理论误差为0.35mm。',c)).toEqual([]);
  expect(errors('系统配置32台R31相机。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'R31'})]));
 });
 it('keeps legacy SceneLab threshold percentages from becoming accuracy measurements',()=>{
  const c=engineering();c.engineering!.performance!.under03Mm=77.75;c.engineering!.performance!.under05Mm=95.08333333333333;
  c.lockedFacts=[{...fact('performance.under03Mm',77.75,'mm','理论误差低于0.3mm比例'),sourceType:'engineering_data',sourceRef:engineeringSource},{...fact('performance.under05Mm',95.08333333333333,'mm','理论误差低于0.5mm比例'),sourceType:'engineering_data',sourceRef:engineeringSource}];
  c.capabilities=[{key:'under03Mm',label:'理论误差低于0.3mm比例',value:77.75,unit:'mm',sourceRef:engineeringSource}];
  expect(errors('理论误差低于0.3mm的点占比为77.75%。理论误差低于0.5mm的点占比为95.08%。',c)).toEqual([]);
  expect(errors('比例为77.75%的点误差低于0.3mm。比例为95.08%的点误差低于0.5mm。',c)).toEqual([]);
  expect(errors('比例为80%的点误差低于0.3mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',quote:'80%'})]));
  expect(errors('比例为77.75%的点误差低于0.4mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
  expect(errors('系统定位精度为77.75mm。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim',quote:'77.75mm'})]));
  expect(errors('覆盖率为77.75%。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'unsupported_claim'})]));
 });
 it('does not label clearly pending values as established performance',()=>{
  const issues=errors('精度0.05mm待确认。建议配置36台K18相机。帧率200fps尚未确认。是否支持PTP同步待验证。');
  expect(issues.map(issue=>issue.type)).toEqual(['customer_facing']);
  expect(issues.some(issue=>['fact_mismatch','unsupported_claim'].includes(issue.type))).toBe(false);
 });
 it('warns about an uncited capability even when the project has unrelated locked facts',()=>{
  const c=context();c.lockedFacts=[fact('deployment.equipmentCount',32,'台','相机数量')];
  expect(check('系统支持水下动作捕捉。',c)).toEqual(expect.arrayContaining([expect.objectContaining({type:'missing_source',severity:'warning',quote:'系统支持水下动作捕捉'})]));
  expect(check('系统支持水下动作捕捉。',c,[source('系统支持水下动作捕捉。')])).toEqual([]);
  expect(check('是否支持水下动作捕捉待确认。',c).map(issue=>issue.type)).toEqual(['customer_facing']);
  expect(check('客户要求支持水下动作捕捉。',c)).toEqual([]);
 });
 it('uses visible rich-text runs and audits unlisted claims, images, missing sections and stale contexts',()=>{
  const c=context();c.lockedFacts=[fact('cameraCount',32,'台','相机数量')];
  const s=section([{id:'rich',type:'paragraph',text:'配置32台K18相机',runs:[{text:'配置36台K18相机',bold:true}]},{id:'foreign',type:'asset',assetId:'other-project',caption:'外部图片'}]);
  const result=validateSections([s,section([])],c,true);
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({type:'fact_mismatch',blockId:'rich'}),expect.objectContaining({type:'missing_source',blockId:'foreign'}),expect.objectContaining({type:'stale_context'}),expect.objectContaining({type:'incomplete',severity:'warning'})]));
 });
});
