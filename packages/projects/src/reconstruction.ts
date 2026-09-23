import type { ProjectFingerprint } from './types.js';
export interface ReconstructionEvidence {projectInputId:string;excerpt:string;sourceDocumentId:string;sourceVersionId:string;sourceBlockIndex:number;headingPath:string[]}
export interface ReconstructionReview {
 revision:number;scope:'historical_reconstruction_only';reviewedBy:string;summary:string;products:string[];fingerprint:ProjectFingerprint;doNotClaim:string[];
 requirements:{category:string;label:string;value:string;unit?:string;evidence:ReconstructionEvidence;additionalEvidence?:ReconstructionEvidence[]}[];
 facts:{key:string;label:string;value:unknown;unit?:string;evidence:ReconstructionEvidence;additionalEvidence?:ReconstructionEvidence[]}[];
}
export function isHistoricalReconstructionProject(description:string){return description.includes('[historical_reconstruction_only]')||/历史项目原文复建的质量回归样例[，,]\s*非新增客户确认/.test(description);}
