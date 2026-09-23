export interface SourceReference { type:'project_input'|'engineering_data'|'structured_fact'|'knowledge_chunk'|'user'; id:string; label:string; evidence?:string; versionId?:string; authority?:string }
export interface RequirementItem { id:string; key?:string; value:unknown; sourceInputId:string; sourceChunkId?:string; evidence:string; confidence:number; confirmedByUser:boolean }
export interface RequirementQuestion { id:string; key:string; question:string; sourceInputId?:string; resolved?:boolean }
export interface ProjectRequirements {
 projectName?:string; customerName?:string; application?:string; goals:RequirementItem[];
 performance:{accuracy?:RequirementItem;frameRate?:RequirementItem;latency?:RequirementItem;coverage?:RequirementItem;range?:RequirementItem;cameraCount?:RequirementItem};
 interfaces:RequirementItem[];protocols:RequirementItem[];environment:RequirementItem[];installationConstraints:RequirementItem[];specialRequirements:RequirementItem[];acceptanceCriteria:RequirementItem[];unresolved:RequirementQuestion[];
}
export interface ProjectAsset { id:string;projectId:string;inputId:string;role:string;filename:string;mimeType:string;objectKey:string;width?:number;height?:number;caption?:string;sourceRef:SourceReference;url:string }
export interface EngineeringData {
 sourceType:string;scene?:{boundaryM?:[number,number,number]};deployment?:{equipmentCount?:number;models?:{name:string;count:number}[]};
 performance?:{coverageGe1?:number;coverageGe2?:number;coverageGe3?:number;coverageGe4?:number;coverageGe5?:number;averageViewCount?:number;meanErrorMm?:number|null;p90ErrorMm?:number|null;p95ErrorMm?:number|null;under03Mm?:number;under05Mm?:number};
 assets:ProjectAsset[];sourceRef:SourceReference;metadata?:{schemeId?:string;schemeRevision?:number;generatedAt?:string;accuracyMetric?:string;coverageUnit?:string};
}
export interface LockedFact { id:string;key:string;label:string;value:unknown;unit?:string;sourceType:'customer_requirement'|'engineering_data'|'structured_fact'|'user';sourceRef:SourceReference;locked:true }
export interface ProjectCapability { key:string;label:string;value:unknown;unit?:string;sourceRef:SourceReference }
export interface ProjectConflict { id:string;key:string;severity:'warning'|'error';message:string;requirement?:RequirementItem;actual?:unknown;sourceRefs:SourceReference[];status:'open'|'resolved' }
export interface ProjectContext { projectId:string;revision:number;inputRevision?:number;reviewedInputIds?:string[];confirmed:boolean;confirmedAt?:string;summary:string;requirements:ProjectRequirements;engineering?:EngineeringData;lockedFacts:LockedFact[];products:string[];capabilities:ProjectCapability[];assets:ProjectAsset[];conflicts:ProjectConflict[];unresolved:RequirementQuestion[] }
export interface ProjectInput { id:string;projectId:string;documentId?:string;kind:'document'|'text'|'engineering';filename:string;title:string;status:'ready'|'failed';createdAt:string;warnings:string[];error?:string }
export interface Project { id:string;organizationId:string;workspaceId:string;name:string;customerName?:string;description:string;companyName:string;documentType:string;status:'draft'|'parsing'|'context_ready'|'generating'|'generated'|'validated'|'archived';contextRevision:number;confirmedRevision:number|null;createdAt:string;updatedAt:string;inputs:ProjectInput[];assets:ProjectAsset[] }
export interface ContextPatch { revision:number;summary?:string;requirements?:ProjectRequirements;products?:string[];facts?:{key:string;label:string;value:unknown;unit?:string}[];resolvedQuestionIds?:string[] }
