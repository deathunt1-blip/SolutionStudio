export interface ModelProfile {
 contextTokens:number;defaultOutputTokens:number;requestTimeoutMs:number;temperature:number;
 inputCnyPerMillion:number;outputCnyPerMillion:number;cacheWriteCnyPerMillion:number;
}
// Published Moonshot China rates, 2026-09-24. Estimates include a conservative 5-minute cache write.
// https://platform.kimi.com/docs/pricing/chat
export function modelProfile(model:string):ModelProfile {
 if(model==='kimi-k3')return {contextTokens:1048576,defaultOutputTokens:131072,requestTimeoutMs:600000,temperature:1,inputCnyPerMillion:20,outputCnyPerMillion:100,cacheWriteCnyPerMillion:20};
 if(model==='kimi-k2.6')return {contextTokens:262144,defaultOutputTokens:32768,requestTimeoutMs:180000,temperature:.6,inputCnyPerMillion:6.5,outputCnyPerMillion:27,cacheWriteCnyPerMillion:0};
 throw new Error(`Unsupported proposal model: ${model}`);
}
export function estimatedModelCost(model:string,inputTokens:number,outputTokens:number):number {
 const profile=modelProfile(model);
 return (inputTokens*(profile.inputCnyPerMillion+profile.cacheWriteCnyPerMillion)+outputTokens*profile.outputCnyPerMillion)/1e6;
}
