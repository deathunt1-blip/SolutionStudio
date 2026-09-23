import type {Connection} from '../../knowledge/src/database.js';

/** Connected duplicate proposals share one retrieval bucket. Versions and merely
 * similar projects deliberately remain separate. Dismissed/stale evidence does too. */
export async function duplicateRetrievalBuckets(db:Connection):Promise<{documentIds:string[];buckets:string[]}> {
 const members=await db.query<{document_id:string;group_id:string}>(`SELECT dm.document_id,dm.group_id
  FROM document_duplicate_members dm JOIN document_duplicate_groups g ON g.id=dm.group_id
  JOIN documents d ON d.id=dm.document_id
  WHERE d.organization_id='default' AND d.workspace_id='default' AND d.scope='global'
   AND g.status IN ('suggested','confirmed') AND g.relation IN ('exact_duplicate','content_duplicate','near_duplicate')
   AND NOT EXISTS(SELECT 1 FROM document_duplicate_members stale JOIN documents sd ON sd.id=stale.document_id
    WHERE stale.group_id=g.id AND (stale.version_id<>sd.active_version_id OR sd.scope<>'global'
     OR sd.organization_id<>'default' OR sd.workspace_id<>'default'))`);
 const parent=new Map<string,string>();
 const find=(key:string):string=>{if(!parent.has(key))parent.set(key,key);let root=key;while(parent.get(root)!==root)root=parent.get(root)!;while(parent.get(key)!==key){const next=parent.get(key)!;parent.set(key,root);key=next;}return root;};
 const first=new Map<string,string>();
 for(const m of members){const prior=first.get(m.group_id);if(prior){const a=find(prior),b=find(m.document_id);if(a!==b)parent.set(a<b?b:a,a<b?a:b);}else{first.set(m.group_id,m.document_id);find(m.document_id);}}
 const documentIds=[...parent.keys()];return {documentIds,buckets:documentIds.map(id=>'duplicate:'+find(id))};
}
