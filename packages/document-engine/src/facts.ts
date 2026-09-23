import type {EngineeringData,ProjectContext} from '../../projects/src/types.js';
/** Original engineering input stays in the snapshot; confirmed overrides are applied only to the document view. */
export function effectiveEngineering(context:ProjectContext):EngineeringData|undefined{
 const original=context.engineering;if(!original)return undefined;const engineering=structuredClone(original);
 for(const fact of context.lockedFacts.filter(f=>f.sourceType==='user')){
  const [group,key]=fact.key.split('.');if(!['scene','deployment','performance'].includes(group))continue;
  const target=(engineering as any)[group];if(!target||!(key in target))continue;target[key]=structuredClone(fact.value);
 }
 const count=context.lockedFacts.find(f=>f.sourceType==='user'&&f.key==='deployment.equipmentCount');
 if(count&&typeof count.value==='number'&&engineering.deployment?.models?.length===1&&!context.lockedFacts.some(f=>f.sourceType==='user'&&f.key==='deployment.models'))engineering.deployment.models[0].count=count.value;
 return engineering;
}
