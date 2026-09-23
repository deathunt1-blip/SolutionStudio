import {randomUUID} from 'node:crypto';
import type {Connection} from '../../knowledge/src/database.js';
import type {SourceFile} from '../../core/src/types.js';

/** A reference keeps the exact bytes and name supplied by each origin, including old revisions. */
export async function saveSourceReference(tx:Connection,documentId:string,sourceId:string,sourceDocumentId:string,file:SourceFile,objectKey:string) {
 await tx.query(`INSERT INTO document_source_references
  (id,document_id,source_id,source_document_id,source_path,source_url,remote_version,filename,content_hash,object_key,source_metadata,removed)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,false)
  ON CONFLICT(source_id,source_document_id,document_id,content_hash) DO UPDATE SET
  source_path=excluded.source_path,source_url=excluded.source_url,remote_version=excluded.remote_version,
  filename=excluded.filename,source_metadata=excluded.source_metadata,removed=false`,
  [randomUUID(),documentId,sourceId,sourceDocumentId,file.meta.sourcePath??null,file.meta.sourceUri??null,file.meta.version??null,file.meta.filename,file.contentHash,objectKey,JSON.stringify(file.meta.metadata??{})]);
}

export async function retireSourceReferences(tx:Connection,sourceId:string,sourceDocumentId:string) {
 await tx.query('UPDATE document_source_references SET removed=true WHERE source_id=$1 AND source_document_id=$2 AND removed=false',[sourceId,sourceDocumentId]);
}
