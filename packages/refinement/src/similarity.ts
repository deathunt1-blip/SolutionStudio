import path from 'node:path';
import type { Connection } from '../../knowledge/src/database.js';
import { lexicalTokens, queryText } from '../../knowledge/src/search.js';
import { scoped } from '../../knowledge/src/repository.js';
import { buildCorpusCards } from './context.js';
import type { CorpusDocumentCard, DocumentSimilarityProvider, SimilarDocument } from './types.js';

const terms=(text:string)=>new Set(lexicalTokens(text.slice(0,4000)).filter(term=>term.length>1));
function overlap(left:Set<string>,right:Set<string>){if(!left.size||!right.size)return 0;let n=0;for(const value of left)if(right.has(value))n++;return n/Math.sqrt(left.size*right.size);}
const tagTerms=(card:CorpusDocumentCard)=>new Set([...card.applications,...card.topics,...card.products].map(value=>value.toLowerCase()));

/** PostgreSQL lexical retrieval plus title, summary, tags and source-directory similarity. */
export class PostgreSQLDocumentSimilarityProvider implements DocumentSimilarityProvider {
 constructor(private readonly db:Connection,private readonly cards?:CorpusDocumentCard[]){}
 async findSimilar(document:CorpusDocumentCard,limit:number):Promise<SimilarDocument[]> {
  const boundedLimit=Math.max(0,Math.min(50,Math.floor(limit)));if(!boundedLimit)return [];
  const cards=this.cards??await buildCorpusCards(this.db);
  const query=queryText(`${document.title} ${document.summary.slice(0,1200)} ${[...document.topics,...document.products].join(' ')}`,'or');
  const rows=query?await this.db.query<{document_id:string;rank:number}>(`SELECT c.document_id,max(ts_rank_cd(c.search_vector,to_tsquery('simple',$1))) AS rank FROM knowledge_chunks c JOIN documents d ON d.id=c.document_id JOIN document_versions v ON v.id=d.active_version_id WHERE ${scoped} AND d.canonical_document_id IS NULL AND d.status IN ('active','needs_review') AND c.version_id=d.active_version_id AND d.id<>$2 AND v.content_hash<>$3 AND c.search_vector @@ to_tsquery('simple',$1) GROUP BY c.document_id ORDER BY rank DESC LIMIT 200`,[query,document.id,document.contentHash??'']):[];
  const ranks=new Map(rows.map(row=>[row.document_id,Number(row.rank)]));
  const maxRank=Math.max(0,...ranks.values());
  const title=terms(document.title),summary=terms(document.summary),tags=tagTerms(document);
  const ranked:SimilarDocument[]=[];
  for(const card of cards){
   if(card.id===document.id||(document.contentHash&&card.contentHash===document.contentHash))continue;
   const weight=card.userConfirmed?1:(card.confidence??0)>=0.85?0.3:0;
   if(weight===0)continue;
   const sameDirectory=Boolean(document.sourcePath&&card.sourcePath&&path.win32.dirname(document.sourcePath)===path.win32.dirname(card.sourcePath));
   const score=0.35*(maxRank?(ranks.get(card.id)??0)/maxRank:0)+0.25*overlap(title,terms(card.title))+0.15*overlap(summary,terms(card.summary))+0.2*overlap(tags,tagTerms(card))+0.05*Number(sameDirectory);
   if(score>0)ranked.push({document:card,score:Number(score.toFixed(6)),strength:card.userConfirmed?'strong':'weak',weight});
  }
  return ranked.sort((left,right)=>right.score-left.score||right.weight-left.weight||left.document.id.localeCompare(right.document.id)).slice(0,boundedLimit);
 }
}
