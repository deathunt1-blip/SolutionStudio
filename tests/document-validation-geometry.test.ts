import {expect,it} from 'vitest';
import {validateSections} from '../packages/document-engine/src/validation.js';
import type {ProjectContext,LockedFact} from '../packages/projects/src/types.js';
import type {DocumentSection,SourceRef} from '../packages/document-engine/src/types.js';

const user:SourceRef={type:'user',id:'user',label:'用户确认',evidence:'人工确认的项目尺寸'};
const fact=(key:string,label:string,value:unknown,unit?:string):LockedFact=>({id:key,key,label,value,unit,sourceType:'user',sourceRef:user,locked:true});
const context=(facts:LockedFact[]=[]):ProjectContext=>({projectId:'p',revision:1,confirmed:true,summary:'',products:['MC4000'],lockedFacts:facts,capabilities:[],assets:[],conflicts:[],unresolved:[],requirements:{goals:[],performance:{},interfaces:[],protocols:[],environment:[],installationConstraints:[],specialRequirements:[],acceptanceCriteria:[],unresolved:[]}});
const check=(text:string,c=context(),refs:SourceRef[]=[],claims:DocumentSection['claims']=[])=>{
 const section:DocumentSection={id:'s',title:'安装说明',level:1,order:0,generationMode:'ai',requiredContext:[],revision:1,edited:true,status:'edited',sourceRefs:refs,assetRefs:[],lockedFactRefs:[],claims,blocks:[{id:'b',type:'paragraph',text}]};
 return validateSections([section],c).filter(issue=>issue.severity==='error');
};
const geometry=()=>context([fact('scene.wallGeometry','实验墙及顶部空间','实验墙宽约16m、高约7.5m；彩钢顶棚最高处距墙顶约3m'),fact('deployment.installationHeight','相机安装高度','7.57～10.39','m')]);

it('recognizes short dimensions and clearance without treating them as accuracy',()=>{
 expect(check('实验墙宽约16m、高约7.5m，彩钢顶棚最高处距墙顶约3m。',geometry())).toEqual([]);
 expect(check('实验墙宽度约16米，高度约7.5米，顶棚距墙顶约300厘米。',geometry())).toEqual([]);
 expect(check('精度分析以实验墙宽约16m、高约7.5m为环境条件。',geometry())).toEqual([]);
});
it.each(['实验墙宽约17m。','实验墙宽约7.5m、高约16m。','顶棚距墙顶约4m。','实验墙宽约16mm。','系统定位精度达到16m。'])('still rejects unsupported metric/dimension/unit: %s',text=>{
 expect(check(text,geometry()).length).toBeGreaterThan(0);
});
it.each(['相机安装高度为7.57～10.39m。','相机安装高度为7.57至10.39米。','相机安装高度为757cm～1039cm。'])('matches both endpoints and the unit of a locked interval: %s',text=>{
 expect(check(text,geometry())).toEqual([]);
});
it.each(['相机安装高度为8.57～10.39m。','相机安装高度为7.57～11.39m。','相机安装高度为7.57～10.39mm。','相机安装高度为10.39～7.57m。'])('does not accept a range merely because one endpoint matches: %s',text=>{
 expect(check(text,geometry()).length).toBeGreaterThan(0);
});
it('does not reinterpret arbitrary unlabeled product tuples as FOV',()=>{
 const refs:SourceRef[]=[{type:'structured_fact',id:'spec',label:'MC4000 产品规格或简称',evidence:'MC4000 产品规格或简称：2048x2048@180fps（53x53）/PoE-RJ45',authority:'authoritative'}];
 expect(check('MC4000产品视场角53°×53°。',context(),refs)).toEqual(expect.arrayContaining([expect.objectContaining({quote:'53°'})]));
 const explicit:SourceRef={...refs[0],evidence:'MC4000水平视场角53°，垂直视场角53°。'};
 expect(check('MC4000产品水平视场角53°，MC4000产品垂直视场角53°。',context(),[explicit])).toEqual([]);
 expect(check('K18产品视场角53°。',context(),[explicit]).length).toBeGreaterThan(0);
});
it('recognizes C3D as a file format without exempting real camera identifiers',()=>{
 expect(check('数据导出支持FBX、C3D及CSV文件格式。').some(issue=>issue.quote==='C3D')).toBe(false);
 expect(check('系统选用C3相机。')).toEqual(expect.arrayContaining([expect.objectContaining({quote:'C3'})]));
 expect(check('系统选用C3D相机。')).toEqual(expect.arrayContaining([expect.objectContaining({quote:'C3D'})]));
 expect(check('系统选用C3D相机并导出CSV格式。')).toEqual(expect.arrayContaining([expect.objectContaining({quote:'C3D'})]));
 expect(check('系统配置C3D并导出CSV文件。')).toEqual(expect.arrayContaining([expect.objectContaining({quote:'C3D'})]));
});
it('checks explicitly supplemented evidence without upgrading historical, standard or wrong-model sources',()=>{
 const text='MC4000产品视场角53°。',claims:DocumentSection['claims']=[{kind:'principle',text,factIds:[],sourceIds:['old']}];
 const evidence:SourceRef={type:'knowledge_chunk',id:'new',label:'MC4000产品规格书',evidence:'MC4000视场角53°。',authority:'authoritative',manualEvidence:true};
 expect(check(text,context(),[evidence],claims)).toEqual([]);
 const {manualEvidence,...automatic}=evidence;
 expect(check(text,context(),[automatic],claims).length).toBeGreaterThan(0);
 for(const ref of [{...evidence,use:'writing_reference' as const},{...evidence,label:'MC4000系统验收标准'},{...evidence,label:'K18产品规格书',evidence:'K18视场角53°。'}])expect(check(text,context(),[ref],claims).length).toBeGreaterThan(0);
});
it('compares a named two-dimensional site against the locked three-dimensional site without swapping axes',()=>{
 const c=context([fact('scene.boundaryM','场地尺寸',[20,10,3.1],'m')]);
 expect(check('对20m×10m场地进行覆盖核算。',c)).toEqual([]);
 expect(check('场地高度为3.1m。',c)).toEqual([]);
 expect(check('对10m×20m场地进行覆盖核算。',c).length).toBeGreaterThan(0);
 expect(check('场地高度为10m。',c).length).toBeGreaterThan(0);
});
it('keeps two-dimensional region and suffix-labelled geometry distinct from accuracy',()=>{
 const c=context([
  fact('scene.outdoorArea','室外区域尺寸','200m×200m'),
  fact('scene.domeGeometry','穹顶原规划','地面部分100m长、50m宽、10m高，地下部分深10m，总高20m'),
  fact('deployment.opticalCell','原方案光学单元','10m×10m单元'),
 ]);
 expect(check('穹顶区域长100m、宽50m、高10m；地下部分深10m，总高20m。',c)).toEqual([]);
 expect(check('室外区域范围200m×200m。',c)).toEqual([]);
 expect(check('穹顶区域长50m、宽100m。',c).length).toBeGreaterThan(0);
 expect(check('室外区域范围100m×200m。',c).length).toBeGreaterThan(0);
});
it('does not compare LED refresh rate with camera capture frame rate',()=>{
 const c=context([fact('camera.frameRate','相机帧率',180,'fps')]);
 const issues=check('LED屏刷新率为3840Hz。',c);
 expect(issues.some(issue=>issue.message.includes('依据为 180fps'))).toBe(false);
 expect(check('相机帧率为3840Hz。',c).length).toBeGreaterThan(0);
});
