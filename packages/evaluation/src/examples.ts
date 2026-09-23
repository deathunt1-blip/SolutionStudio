import { PGlite } from '@electric-sql/pglite';
import type { Connection } from '../../knowledge/src/database.js';
import { indexText } from '../../knowledge/src/search.js';
import { retrieveConfirmedExamples } from '../../knowledge/src/examples.js';
import type { EvaluationContext, EvaluationDocument, EvaluationManifest } from './types.js';

/** An in-memory PostgreSQL index; evaluation never opens the live data directory. */
export async function createEvaluationExampleRetriever(context:EvaluationContext,manifest:EvaluationManifest,isolateEvaluation=true) {
 const embedded=new PGlite();
 await embedded.waitReady;
 const db:Connection={async query<T>(sql:string,values:unknown[]=[]) {return (await embedded.query(sql,values)).rows as T[];}};
 try {
  await embedded.exec(`CREATE TABLE documents(id text PRIMARY KEY,organization_id text,workspace_id text,scope text,status text,canonical_document_id text,active_version_id text);
   CREATE TABLE confirmed_examples(id text PRIMARY KEY,document_id text,text_summary text,confirmed_fields jsonb,created_at timestamptz,organization_id text,workspace_id text,scope text,search_vector tsvector,version_id text);
   CREATE TABLE document_duplicate_groups(id text PRIMARY KEY,status text,relation text);
   CREATE TABLE document_duplicate_members(group_id text,document_id text,version_id text);
   CREATE INDEX confirmed_examples_fts ON confirmed_examples USING gin(search_vector);`);
  const datasetIds=new Set(manifest.documents.flatMap(doc=>[doc.id,...(doc.sourceDocumentId?[doc.sourceDocumentId]:[])]));
  const datasetHashes=new Set(manifest.documents.map(doc=>doc.contentHash));
  const eligible=context.examples.filter(example=>!isolateEvaluation || (!datasetIds.has(example.documentId) && !example.contentHashes.some(hash=>datasetHashes.has(hash))));
  for(const example of eligible) {
   // Frozen evaluation snapshots use a synthetic current version and no live
   // duplicate decisions; production retrieval still runs against the same schema.
   await db.query("INSERT INTO documents VALUES($1,'default','default','global','active',NULL,'snapshot:'||$1) ON CONFLICT DO NOTHING",[example.documentId]);
   await db.query("INSERT INTO confirmed_examples VALUES($1,$2,$3,$4::jsonb,$5,'default','default','global',to_tsvector('simple',$6),'snapshot:'||$2)",[example.id,example.documentId,example.textSummary,JSON.stringify(example.confirmedFields),example.createdAt,indexText(example.textSummary)]);
  }
  return {
   async retrieve(document:EvaluationDocument,text:string) {
    // A renamed duplicate must not bypass self-exclusion. This applies even when
    // the optional full-dataset isolation is disabled for a deliberate experiment.
    const excluded=eligible.filter(example=>example.documentId===document.id || example.documentId===document.sourceDocumentId || example.contentHashes.includes(document.contentHash)).map(example=>example.id);
    return retrieveConfirmedExamples(db,text.slice(0,12000),document.sourceDocumentId||document.id,excluded);
   },
   close:()=>embedded.close(),
  };
 } catch(error) {await embedded.close();throw error;}
}
