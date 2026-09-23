import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { HttpError } from '../../knowledge/src/service.js';
import type { EngineeringData, EngineeringOpticalConfiguration, ProjectAsset, SourceReference } from './types.js';

const invalid=(message:string):never=>{throw new HttpError(400,`SceneLab 报告包无效：${message}`);};
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function validatePng(buffer:Buffer) {
 if(buffer.length<33||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')invalid('图片不是有效 PNG');
 let offset=8,header=false,image=false,end=false;
 while(offset<buffer.length){if(offset+12>buffer.length)invalid('PNG 图片截断');const length=buffer.readUInt32BE(offset),finish=offset+12+length;if(finish>buffer.length)invalid('PNG 图片数据长度无效');const type=buffer.toString('ascii',offset+4,offset+8);
  let crc=0xffffffff;for(let i=offset+4;i<offset+8+length;i++)crc=crcTable[(crc^buffer[i])&255]^(crc>>>8);if(((crc^0xffffffff)>>>0)!==buffer.readUInt32BE(offset+8+length))invalid('PNG 图片校验失败');
  if(!header){if(type!=='IHDR'||length!==13)invalid('PNG 图片缺少有效头部');header=true;}else if(type==='IHDR')invalid('PNG 图片头部重复');
  if(type==='IDAT')image=true;if(type==='IEND'){if(length||finish!==buffer.length)invalid('PNG 图片结尾无效');end=true;}
  offset=finish;
 }
 if(!header||!image||!end)invalid('PNG 图片不完整');
}
function safePath(name:string) {if(!name||name.length>500||name.startsWith('/')||name.includes('\\')||name.includes(':')||name.split('/').some(part=>part==='..'||part==='.')||/[\x00-\x1f]/.test(name))invalid('包含不安全文件路径');return name;}
/** Inspect ZIP directory sizes before any decompression. Never extract a package to the filesystem. */
function inspectZip(bytes:Uint8Array) {
 const buffer=Buffer.from(bytes);if(buffer.length<22||buffer.length>80*1024*1024)invalid('文件为空或超过 80 MB');
 let end=-1;for(let offset=buffer.length-22;offset>=Math.max(0,buffer.length-65557);offset--)if(buffer.readUInt32LE(offset)===0x06054b50 && offset+22+buffer.readUInt16LE(offset+20)===buffer.length){end=offset;break;}
 if(end<0)invalid('不是完整的 ZIP 报告包');
 if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6))invalid('不支持分卷 ZIP');
 const count=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),start=buffer.readUInt32LE(end+16);
 if(count>512||count===65535||start+directorySize>end)invalid('文件目录或条目数超限');
 let offset=start,total=0;const names=new Set<string>();
 for(let index=0;index<count;index++) {
  if(offset+46>end||buffer.readUInt32LE(offset)!==0x02014b50)invalid('文件目录损坏');
  const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24),length=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
  if(flags&1||![0,8].includes(method)||size>32*1024*1024||local+30>start||compressed>buffer.length)invalid('加密、压缩类型或单文件大小不受支持');
  if(offset+46+length+extra+comment>start+directorySize)invalid('文件目录损坏');
  const name=safePath(buffer.subarray(offset+46,offset+46+length).toString('utf8'));
  if(names.has(name))invalid('重复文件路径');names.add(name);total+=size;if(total>128*1024*1024)invalid('解压后超过 128 MB');
  if(buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+8)!==method)invalid('文件头不一致');
  const dataStart=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);if(dataStart+compressed>start)invalid('文件数据越界');
  // Do not trust a maliciously understated uncompressed size in the directory.
  try{const data=method===8?inflateRawSync(buffer.subarray(dataStart,dataStart+compressed),{maxOutputLength:Math.max(1,size+1)}):buffer.subarray(dataStart,dataStart+compressed);if(data.length!==size)invalid('声明的解压大小不匹配');}catch{invalid('解压大小或压缩数据无效');}
  offset+=46+length+extra+comment;
 }
 if(offset!==start+directorySize)invalid('文件目录长度不匹配');
}
const number=(value:unknown,label:string,min=0,max=Infinity)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)invalid(`${label} 数值无效`);return value as number;};
const tuple=(value:unknown,label:string):[number,number,number]=>{if(!Array.isArray(value)||value.length!==3)invalid(`${label} 必须是三个尺寸`);return (value as unknown[]).map(v=>number(v,label,Number.MIN_VALUE)) as [number,number,number];};

export class SceneLabReportAdapter {
 async parse(bytes:Uint8Array,projectId:string,inputId:string,filename:string):Promise<{engineering:EngineeringData;assets:{asset:ProjectAsset;bytes:Uint8Array}[];warnings:string[]}> {
  inspectZip(bytes);let zip:JSZip;try{zip=await JSZip.loadAsync(bytes,{checkCRC32:true});}catch{invalid('ZIP 校验失败');}
  const json=async(name:string)=>{const entry=zip.file(safePath(name));if(!entry)invalid(`缺少 ${name}`);let value:any;try{const text=await entry!.async('string');if(Buffer.byteLength(text)>8*1024*1024)invalid('JSON 文件过大');value=JSON.parse(text);}catch{invalid(`${name} 不是有效 JSON`);}if(!value||typeof value!=='object'||Array.isArray(value))invalid(`${name} 结构无效`);return value;};
  const manifest=await json('manifest.json');if(manifest.format!=='scenelab-report'||manifest.format_version!=='1.0')invalid('仅支持 scenelab-report 1.0');
  const project=await json(manifest.files?.project||'project.json'),analysis=await json(manifest.files?.analysis||'analysis.json');
  if(typeof project.scheme_id!=='string'||analysis.scheme_id!==project.scheme_id||!Number.isInteger(project.scheme_revision)||analysis.scheme_revision!==project.scheme_revision||manifest.project?.scheme_revision!==project.scheme_revision)invalid('项目、分析与 manifest 的方案版本不一致');
  const boundary=tuple(project.boundary_m,'场地'),analysisBoundary=tuple(analysis.settings?.boundary_m,'分析场地');if(JSON.stringify(boundary)!==JSON.stringify(analysisBoundary))invalid('项目与分析场地尺寸不一致');
  if(project.units?.position!=='m'||project.units?.accuracy!=='mm')invalid('工程单位必须为 m / mm');
  if(!Array.isArray(project.cameras)||project.cameras.length>10000)invalid('相机列表无效');
  const sourceRef:SourceReference={type:'engineering_data',id:inputId,label:filename,evidence:`方案 ${project.scheme_name||''} R${project.scheme_revision}；原始工程分析`};
  const models=new Map<string,number>(),optics=new Map<string,EngineeringOpticalConfiguration>();const ids=new Set<string>();let equipmentCount=0;
  const optionalNumber=(value:unknown,label:string,max=Infinity)=>value===undefined?undefined:value===null?null:number(value,label,0,max);
  for(const camera of project.cameras){if(!camera||typeof camera.id!=='string'||ids.has(camera.id)||typeof camera.enabled!=='boolean')invalid('相机标识或启用状态无效');ids.add(camera.id);if(!camera.enabled)continue;
   const model=camera.camera_model,name=model?.catalog?.camera?.model||model?.model_name||model?.display_name;if(typeof name!=='string'||!name.trim()||name.length>200)invalid('启用相机缺少型号');models.set(name,(models.get(name)||0)+1);equipmentCount++;
   const variant=model.catalog?.optical?.profile_name??model.variant,rangeMode=model.range_mode;
   if(variant!==undefined&&(typeof variant!=='string'||variant.length>200)||rangeMode!==undefined&&(typeof rangeMode!=='string'||rangeMode.length>100))invalid('光学配置名称无效');
   const focalLengthMm=optionalNumber(model.focal_length_mm,'仿真镜头焦距'),apertureF=optionalNumber(model.catalog?.optical?.aperture_f,'镜头光圈');
   // Top-level camera_model values are the actual simulation inputs; catalog defaults may differ.
   const configuration={model:name,variant,lens:focalLengthMm!==undefined||apertureF!==undefined?{focalLengthMm,apertureF}:undefined,hfovDeg:optionalNumber(model.hfov_deg,'仿真水平视场角',360),vfovDeg:optionalNumber(model.vfov_deg,'仿真垂直视场角',360),maxWorkingDistanceM:optionalNumber(model.max_working_distance_m,'仿真最大工作距离'),rangeMode};
   if(![focalLengthMm,apertureF,configuration.hfovDeg,configuration.vfovDeg,configuration.maxWorkingDistanceM].some(value=>typeof value==='number'))continue;
   const key=JSON.stringify(configuration),existing=optics.get(key);
   if(existing)existing.cameraIds.push(camera.id);else optics.set(key,{...configuration,cameraIds:[camera.id],sourceRef:{...sourceRef,label:`${name}${variant?` · ${variant}`:''} 工程仿真光学配置`,evidence:`原报告仿真配置：${JSON.stringify(configuration)}。这些值为工程分析输入，不代表实测产品能力。`}});
  }
  const coverage=analysis.coverage_percent,accuracy=analysis.accuracy_mm,threshold=analysis.threshold_percent;if(!coverage||!accuracy||!threshold)invalid('缺少覆盖或精度分析');
  const nullable=(value:unknown,label:string)=>value===null?null:number(value,label);
  const result:EngineeringData={sourceType:'scenelab',scene:{boundaryM:boundary},deployment:{equipmentCount,models:[...models].map(([name,count])=>({name,count})),opticalConfigurations:[...optics.values()]},
   performance:{coverageGe1:number(coverage.ge1,'覆盖率',0,100),coverageGe2:number(coverage.ge2,'覆盖率',0,100),coverageGe3:number(coverage.ge3,'覆盖率',0,100),coverageGe4:number(coverage.ge4,'覆盖率',0,100),coverageGe5:number(coverage.ge5,'覆盖率',0,100),averageViewCount:number(analysis.average_view_count,'平均视点数'),meanErrorMm:nullable(accuracy.mean,'平均误差'),p90ErrorMm:nullable(accuracy.p90,'P90误差'),p95ErrorMm:nullable(accuracy.p95,'P95误差'),under03Mm:number(threshold.under_0_3mm,'误差阈值比例',0,100),under05Mm:number(threshold.under_0_5mm,'误差阈值比例',0,100)},
   assets:[],sourceRef,metadata:{adapterVersion:2,schemeId:project.scheme_id,schemeRevision:project.scheme_revision,generatedAt:analysis.generated_at,accuracyMetric:analysis.statistics?.accuracy_metric,coverageUnit:analysis.statistics?.coverage_unit}};
  if(!Array.isArray(manifest.images)||manifest.images.length>64)invalid('图片清单无效');
  const assets:{asset:ProjectAsset;bytes:Uint8Array}[]=[];const used=new Set<string>();
  const addImage=async(entry:any,cameraView=false)=>{
   const file=safePath(entry.file||entry.image||'');if(used.has(file))invalid('图片清单重复');used.add(file);if(!/^images\/|^camera_views\//.test(file)||!file.toLowerCase().endsWith('.png'))invalid('图片路径或格式无效');
   const item=zip.file(file);if(!item)invalid(`缺少图片 ${file}`);const data=await item!.async('uint8array');const buffer=Buffer.from(data);
   validatePng(buffer);
   const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);if(!width||!height||width>16000||height>16000||width*height>64000000)invalid('图片尺寸超限');
   if(!Array.isArray(entry.image_size_px)||entry.image_size_px[0]!==width||entry.image_size_px[1]!==height)invalid('图片声明尺寸不一致');
   const role=cameraView?'camera_view':`${entry.role}_${entry.view}`;if(!cameraView&&(!['deployment','coverage','accuracy','manual'].includes(entry.role)||!['perspective','top','front','side'].includes(entry.view)))invalid('未知图片角色');
   const captions:Record<string,string>={deployment_perspective:'相机部署透视图',coverage_top:'捕捉覆盖俯视图',coverage_perspective:'捕捉覆盖透视图',accuracy_perspective:'理论精度透视图',accuracy_front:'理论精度前视图',accuracy_side:'理论精度侧视图'};
   const id=randomUUID();const asset:ProjectAsset={id,projectId,inputId,role,filename:file.split('/').at(-1)!,mimeType:'image/png',objectKey:`projects/${projectId}/assets/${id}.png`,width,height,caption:cameraView?`相机视图 ${entry.camera_name||entry.camera_id||''}`:captions[role]||'工程补充视图',sourceRef,url:`/api/projects/${projectId}/assets/${id}`};assets.push({asset,bytes:data});
  };
  for(const entry of manifest.images)await addImage(entry);
  if(manifest.camera_views?.included){const index=await json(manifest.camera_views.index);if(index.scheme_id!==project.scheme_id||index.scheme_revision!==project.scheme_revision||!Array.isArray(index.views)||index.views.length>256)invalid('相机视图版本不一致或数量超限');for(const view of index.views)await addImage(view,true);}
  result.assets=assets.map(item=>item.asset);
  const warnings=['工程精度是理论分析结果，不代表实测或验收承诺。'];if(manifest.diagnostics?.included)warnings.push('内部诊断信息已保留在原包中，不纳入客户正文。');
  return {engineering:result,assets,warnings};
 }
}
