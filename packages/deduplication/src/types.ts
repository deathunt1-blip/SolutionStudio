import type { ParsedDocument } from '../../core/src/types.js';

export type DuplicateRelation = 'exact_duplicate' | 'content_duplicate' | 'near_duplicate' | 'possible_version' | 'similar' | 'none';
export interface DocumentDifference {
  kind: 'version' | 'date' | 'number' | 'model' | 'project' | 'text' | 'table';
  /** A human-readable source location, e.g. tables[0].rows[2][1] or plainText:line 4. */
  location: string;
  before: string;
  after: string;
}
export interface DuplicateAssessment {
  relation: DuplicateRelation;
  score: number;
  reasons: string[];
  differences?: DocumentDifference[];
}
export interface DedupDocument {
  id: string;
  title?: string;
  filename?: string;
  contentHash?: string;
  normalizedContentHash?: string | null;
  parsedDocument?: ParsedDocument;
  plainText?: string;
  documentType?: string;
  products?: string[];
  topics?: string[];
  version?: string;
  date?: string;
}
export interface DuplicateDetector {
  compare(a: DedupDocument, b: DedupDocument): Promise<DuplicateAssessment>;
}
export interface CandidateOptions {
  focusDocumentIds?: string[];
  maxPairs?: number;
  maxPairsPerDocument?: number;
  maxBucketSize?: number;
  oversizedBucketNeighbors?: number;
}
export interface CandidateResult {
  pairs: [string, string][];
  /** Any limit or oversized bucket means some candidates may not have been examined. */
  truncated: boolean;
  stats: {
    documentCount: number;
    bucketCount: number;
    oversizedBuckets: number;
    candidatePairs: number;
    maxPairs: number;
    skippedComparisonsLowerBound: number;
  };
}
